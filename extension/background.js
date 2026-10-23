/**
 * Service worker：唯一的出网口。
 * 密钥只在这里被读出来用，content script 永远看不到。
 *
 * 消息：`translate` / `testProvider` / `status` / `models.list`
 */

import {
  getActiveProvider,
  getSessionId,
  getSettings,
  patchProvider,
} from './lib/settings.js';
import { getPreset } from './lib/provider-presets.js';
import { loadModelList, resolveModelsUrl } from './lib/models.js';
import { normalizeTerms } from './lib/glossary.js';
import { reviewTranslations, translateBatch } from './lib/providers.js';

/** @typedef {import('../types').ProviderConfig} ProviderConfig */
/** @typedef {import('../types').Settings} Settings */

/** 模型列表缓存有效期：7 天 */
const MODELS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

/** @type {{ key: string, terms: string[] } | null} */
let glossaryCache = null;
/** @type {Promise<string[]> | null} */
let builtinTermsCache = null;

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const settings = await getSettings();
  if (settings.providers.length === 0) chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) glossaryCache = null;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const task = route(message);
  if (!task) return false;
  task.then(sendResponse, (err) =>
    sendResponse({ ok: false, error: err?.message || String(err) }),
  );
  return true; // 保持通道等异步结果
});

/** 只处理自己认识的消息，其余交回给别的监听者 */
function route(message) {
  switch (message?.type) {
    case 'translate':
      return translate(message.texts);
    case 'testProvider':
      return testProvider(message.config, message.sample);
    case 'status':
      return status();
    case 'models.list':
      return listModels(message.provider);
    default:
      return null;
  }
}

/** @param {unknown} texts @returns {string[]} */
function normalizeTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) throw new Error('没有要翻译的文本');
  return texts.map((t) => String(t ?? ''));
}

/* ------------------------------- 词库 ------------------------------- */

/** @returns {Promise<string[]>} */
async function loadBuiltinTerms() {
  if (builtinTermsCache) return builtinTermsCache;
  builtinTermsCache = (async () => {
    try {
      const url = chrome.runtime.getURL('lib/glossary-data.json');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data?.terms) ? data.terms.map(String) : [];
    } catch (err) {
      // 文件缺失或 JSON 坏了都不该阻断翻译，退化为只用用户词
      console.warn('[sopen-translate] 内置词库加载失败，继续用用户词', err);
      builtinTermsCache = null;
      return [];
    }
  })();
  return builtinTermsCache;
}

/**
 * @param {Settings} settings
 * @returns {Promise<string[]>}
 */
async function getGlossaryTerms(settings) {
  const user = normalizeTerms(settings.glossary.terms);
  if (!settings.glossary.useBuiltin) return user;

  const key = `${settings.glossary.useBuiltin}\u0000${user.join('\u0000')}`;
  if (glossaryCache?.key === key) return glossaryCache.terms;

  const builtin = await loadBuiltinTerms();
  const terms = normalizeTerms([...builtin, ...user]);
  glossaryCache = { key, terms };
  return terms;
}

/* ------------------------------- 消息实现 ------------------------------- */

/**
 * OpenCode Go 必须带 x-opencode-session，否则全部 400。
 * `User-Agent` 在浏览器 fetch 里不可靠，不作为成功条件。
 * @param {ProviderConfig} provider
 * @returns {Promise<Record<string, string> | undefined>}
 */
async function sessionHeaders(provider) {
  const preset = getPreset(provider.presetId);
  if (!preset.requiresSession) return undefined;
  return { 'x-opencode-session': await getSessionId() };
}

/** @param {string[]} texts */
async function translate(texts) {
  const list = normalizeTexts(texts);
  const { settings, provider } = await getActiveProvider();
  if (!provider) throw new Error('还没有配置翻译服务，先去设置页添加一个');

  const glossary = await getGlossaryTerms(settings);
  const extraHeaders = await sessionHeaders(provider);

  const result = await translateBatch({
    texts: list,
    config: provider,
    target: settings.targetLang,
    targetCode: settings.targetLangCode,
    glossary,
    enforcement: settings.enforcement,
    extraHeaders,
  });

  // 可选审校层：主译文不动，只让第二个 LLM 修正规则筛出的可疑段。
  let translations = result.translations;
  /** @type {import('../types').ReviewOutcome | undefined} */
  let review;
  const reviewProvider = settings.reviewProviderId
    ? settings.providers.find((p) => p.id === settings.reviewProviderId)
    : null;
  if (reviewProvider) {
    const reviewed = await reviewTranslations({
      sources: list,
      translations,
      config: reviewProvider,
      target: settings.targetLang,
      targetCode: settings.targetLangCode,
      glossary,
      extraHeaders: await sessionHeaders(reviewProvider),
    });
    translations = reviewed.translations;
    review = reviewed.review;
  }

  return {
    ok: true,
    translations,
    protected: result.protected,
    warnings: result.warnings,
    review,
  };
}

/**
 * 测试按钮走同一条 pipeline，但关掉术语层、只用 warn——
 * 否则 OpenCode Go 的“测试”永远 400，术语回退也会把结果换成原文。
 * @param {ProviderConfig} config
 * @param {string} [sample]
 */
async function testProvider(config, sample) {
  if (!config) throw new Error('缺少服务配置');
  const settings = await getSettings();
  const texts = [sample || 'Hello, world.'];
  const extraHeaders = await sessionHeaders(config);

  const started = Date.now();
  const result = await translateBatch({
    texts,
    config,
    target: settings.targetLang,
    targetCode: settings.targetLangCode,
    glossary: [],
    enforcement: 'warn',
    extraHeaders,
  });

  return {
    ok: true,
    result: result.translations[0],
    elapsed: Date.now() - started,
    provider: getPreset(config.presetId).label,
  };
}

async function status() {
  const settings = await getSettings();
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  return {
    ok: true,
    providerCount: settings.providers.length,
    active: provider
      ? {
          label: provider.label || getPreset(provider.presetId).label,
          presetId: provider.presetId,
          protocol: provider.protocol,
        }
      : null,
    targetLang: settings.targetLang,
    displayMode: settings.displayMode,
    enforcement: settings.enforcement,
  };
}

/**
 * 永远返回 ok: true：拉不到列表就退回预设建议，真正的鉴权错误交给“测试”按钮。
 * @param {ProviderConfig} provider
 */
async function listModels(provider) {
  if (!provider) throw new Error('缺少服务配置');
  const preset = getPreset(provider.presetId);

  if (provider.protocol !== 'openai-chat' || !preset.supportsModelList) {
    return { ok: true, models: (preset.models || []).slice(), from: 'preset', cached: false };
  }

  const url = resolveModelsUrl(provider);
  const settings = await getSettings();
  const saved = settings.providers.find((p) => p.id === provider.id);

  if (
    saved?.modelsCache &&
    url &&
    saved.modelsCache.forUrl === url &&
    Date.now() - saved.modelsCache.at < MODELS_CACHE_TTL
  ) {
    return { ok: true, models: saved.modelsCache.list.slice(), from: 'cache', cached: true };
  }

  const { models, from } = await loadModelList({ config: provider, preset, timeoutMs: 8000 });

  let cached = false;
  if (
    from === 'network' &&
    models.length > 0 &&
    saved &&
    url &&
    saved.baseUrl === provider.baseUrl &&
    saved.modelsUrl === provider.modelsUrl &&
    saved.apiKey === provider.apiKey
  ) {
    // 只写「已保存且配置一致」的 provider，避免设置页草稿污染存储
    await patchProvider(provider.id, {
      modelsCache: { at: Date.now(), list: models, forUrl: url },
    });
    cached = true;
  }

  return { ok: true, models, from, cached };
}
