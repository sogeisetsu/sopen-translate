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
import { getProtocol } from './lib/protocols.js';
import { loadModelList, resolveModelsUrl } from './lib/models.js';
import { compileGlossary, normalizeTerms } from './lib/glossary.js';
import { reviewTranslations, translateBatch } from './lib/providers.js';
import {
  REVIEW_MAX_CHARS,
  REVIEW_MAX_SEGMENTS,
  findSuspicious,
  hostOf,
  pageKind,
  selectReviewItems,
} from './lib/review.js';
import { appendDebugEntry, makeDebugEntry, sampleText } from './lib/debug-log.js';

/** @typedef {import('../types').ProviderConfig} ProviderConfig */
/** @typedef {import('../types').Settings} Settings */

/** 模型列表缓存有效期：7 天 */
const MODELS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

/** @type {{ key: string, terms: string[] } | null} */
let glossaryCache = null;
/** @type {Promise<string[]> | null} */
let builtinTermsCache = null;

/** 审校预算按页面 token 累计，1 小时后清掉；避免 service worker 长期占用内存 */
const REVIEW_BUDGET_TTL = 60 * 60 * 1000;
const REVIEW_BUDGET_MAX_TOKENS = 50;
/** @type {Map<string, { segments: number, chars: number, at: number }>} */
const reviewBudgets = new Map();

/**
 * @param {string} token
 * @returns {{ segments: number, chars: number, at: number }}
 */
function reviewBudget(token) {
  const now = Date.now();
  for (const [key, value] of reviewBudgets) {
    if (now - value.at > REVIEW_BUDGET_TTL) reviewBudgets.delete(key);
  }
  let budget = reviewBudgets.get(token);
  if (!budget) {
    budget = { segments: 0, chars: 0, at: now };
    reviewBudgets.set(token, budget);
    if (reviewBudgets.size > REVIEW_BUDGET_MAX_TOKENS) {
      const oldest = reviewBudgets.keys().next().value;
      if (oldest) reviewBudgets.delete(oldest);
    }
  }
  return budget;
}

/* ------------------------------- 调试日志 ------------------------------- */

/** 开启状态缓存：避免每条日志都读一次 settings；设置一变就清空 */
/** @type {boolean | null} */
let debugEnabledCache = null;
/** 串行写盘：多个 context 同时 debug.log 时不能互相覆盖 */
let debugWriteQueue = Promise.resolve();

/**
 * @param {unknown} err
 * @returns {Record<string, unknown>}
 */
function errorData(err) {
  const anyError = /** @type {{ status?: unknown, name?: unknown, message?: unknown }} */ (err);
  const message = String(anyError?.message ?? err);
  const host = message.match(/https?:\/\/([^/\s:]+)/)?.[1];
  return {
    name: String(anyError?.name ?? 'Error'),
    ...(Number.isInteger(anyError?.status) ? { status: anyError.status } : {}),
    ...(host ? { host } : {}),
  };
}

/**
 * 写一条调试日志。关闭时是零写入；任何异常都吞掉，不能影响翻译。
 * @param {Record<string, any>} input
 * @param {chrome.runtime.MessageSender} [sender]
 * @returns {Promise<{ ok: boolean, skipped?: boolean }>}
 */
async function logDebug(input, sender) {
  try {
    const settings = await getSettings();
    if (!settings.debugLogEnabled) return { ok: true, skipped: true };

    /** @type {Record<string, any>} */
    const payload = { ...input };
    const tab = sender?.tab;
    if (Number.isInteger(tab?.id)) payload.tabId = tab?.id;
    if (tab?.url && !payload.url) payload.url = tab.url;
    if (payload.sample) {
      const sample = payload.sample;
      delete payload.sample;
      // 只有显式开启 samples 才把页面文本写进日志
      if (settings.debugLogSamples) {
        payload.data = {
          ...(payload.data || {}),
          sample: {
            source: sampleText(sample.source),
            primary: sampleText(sample.primary),
          },
        };
      }
    }

    const entry = makeDebugEntry(payload);
    const task = debugWriteQueue.then(async () => {
      const stored = await chrome.storage.local.get('debugLog');
      const entries = appendDebugEntry(
        Array.isArray(stored.debugLog)
          ? /** @type {import('../types').DebugLogEntry[]} */ (stored.debugLog)
          : [],
        entry,
      );
      await chrome.storage.local.set({ debugLog: entries });
    });
    debugWriteQueue = task.catch(() => {});
    await task;
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * @param {unknown} limit
 */
async function getDebugLog(limit) {
  const settings = await getSettings();
  const stored = await chrome.storage.local.get('debugLog');
  const entries = Array.isArray(stored.debugLog) ? stored.debugLog : [];
  const max =
    Number.isInteger(limit) && Number(limit) > 0
      ? Math.min(Number(limit), entries.length)
      : entries.length;
  return {
    ok: true,
    enabled: settings.debugLogEnabled,
    samples: settings.debugLogSamples,
    entries: entries.slice(-max),
  };
}

async function clearDebugLog() {
  await chrome.storage.local.set({ debugLog: [] });
  return { ok: true };
}

/** @param {unknown} err */
function markLogged(err) {
  if (err && typeof err === 'object') {
    try {
      /** @type {Record<string, unknown>} */ (err).__logged = true;
    } catch {
      /* 冻结对象等忽略 */
    }
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  void logDebug({
    level: 'info',
    event: 'app.start',
    source: 'background',
    message: `onInstalled:${reason}`,
  });
  if (reason !== 'install') return;
  const settings = await getSettings();
  if (settings.providers.length === 0) chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  void logDebug({
    level: 'info',
    event: 'app.start',
    source: 'background',
    message: 'onStartup',
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    glossaryCache = null;
    debugEnabledCache = null;
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const task = route(message, sender);
  if (!task) return false;
  task.then(sendResponse, (err) => {
    // 统一记一次错误；不记录请求头/响应体
    if (!/** @type {any} */ (err)?.__logged) {
      void logDebug({
        level: 'error',
        event: 'error',
        source: 'background',
        message: err?.message || String(err),
        data: errorData(err),
      });
    }
    sendResponse({ ok: false, error: err?.message || String(err) });
  });
  return true; // 保持通道等异步结果
});

/** 只处理自己认识的消息，其余交回给别的监听者 */
function route(message, sender) {
  switch (message?.type) {
    case 'translate':
      return translate(message.texts, message.pageToken);
    case 'review.run':
      return runReview(message);
    case 'testProvider':
      return testProvider(message.config, message.sample);
    case 'status':
      return status();
    case 'models.list':
      return listModels(message.provider);
    case 'debug.log':
      return logDebug(message, sender);
    case 'debug.get':
      return getDebugLog(message?.limit);
    case 'debug.clear':
      return clearDebugLog();
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

/**
 * @param {string[]} texts
 * @param {string} [pageToken] content 每轮页面翻译生成；用于累计审校预算
 */
async function translate(texts, pageToken) {
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

  // 审校已改为异步：这里只做纯 CPU 规则筛选，把可疑段随主译文一起返回。
  // LLM 主翻译已走术语注入 + repair，不再重复审校（MT-only 门禁）。
  const reviewProvider = settings.reviewProviderId
    ? settings.providers.find((p) => p.id === settings.reviewProviderId)
    : null;

  /** @type {import('../types').ReviewCandidate[]} */
  let reviewCandidates = [];
  /** @type {string | undefined} */
  let reviewSkipped;
  if (reviewProvider) {
    const primaryProtocol = getProtocol(provider.protocol);
    if (primaryProtocol.supportsGlossary !== false) {
      reviewSkipped = 'llm-primary';
    } else if (getProtocol(reviewProvider.protocol).supportsGlossary !== false) {
      const compiled = compileGlossary(glossary);
      reviewCandidates = findSuspicious({
        sources: list,
        translations: result.translations,
        compiled,
        targetCode: settings.targetLangCode,
      }).items;
    }
    // 审校服务本身是 MT：选项页已过滤，这里直接不给候选，也不发请求
  }

  /** @type {Record<string, any>} */
  const response = {
    ok: true,
    translations: result.translations,
    protected: result.protected,
    warnings: result.warnings,
  };
  if (reviewProvider) {
    response.reviewCandidates = reviewCandidates;
    if (reviewSkipped) response.reviewSkipped = reviewSkipped;
  }
  return response;
}

/**
 * content 在主译文渲染后主动发起审校；预算按 pageToken 累计。
 * @param {any} message
 */
async function runReview(message) {
  const settings = await getSettings();
  const reviewProvider = settings.reviewProviderId
    ? settings.providers.find((p) => p.id === settings.reviewProviderId)
    : null;
  if (!reviewProvider) return { ok: false, error: '没有配置审校服务' };

  const items = sanitizeReviewItems(message?.items);
  /** @type {import('../types').ReviewRunResult} */
  const base = { reviewed: 0, corrected: 0, failed: false, truncated: false };
  if (items.length === 0) {
    return { ok: true, corrections: [], rejected: [], review: base };
  }

  const token =
    typeof message.pageToken === 'string' && message.pageToken ? message.pageToken : 'default';
  const budget = reviewBudget(token);
  const remainingSegments = Math.max(0, REVIEW_MAX_SEGMENTS - budget.segments);
  const remainingChars = Math.max(0, REVIEW_MAX_CHARS - budget.chars);
  if (remainingSegments === 0 || remainingChars === 0) {
    return { ok: true, corrections: [], rejected: [], review: { ...base, truncated: true } };
  }

  // 预算按「原文 + 主译文」字符数算，避免一大段把整页预算吃光
  const selected = selectReviewItems(items, {
    maxSegments: remainingSegments,
    maxChars: remainingChars,
  });
  const picked = selected.items;
  const truncated = selected.truncated;
  if (picked.length === 0) {
    return { ok: true, corrections: [], rejected: [], review: { ...base, truncated: true } };
  }

  const glossary = await getGlossaryTerms(settings);
  const url = String(message?.context?.url ?? '');
  void logDebug({
    level: 'info',
    event: 'review.start',
    source: 'background',
    message: `${picked.length} 段`,
    data: { items: picked.length, host: hostOf(url), truncated },
  });
  const reviewed = await reviewTranslations({
    items: picked,
    config: reviewProvider,
    target:
      typeof message?.target === 'string' && message.target
        ? message.target
        : settings.targetLang,
    targetCode:
      typeof message?.targetCode === 'string' && message.targetCode
        ? message.targetCode
        : settings.targetLangCode,
    context: {
      title: String(message?.context?.title ?? ''),
      host: hostOf(url),
      kind: pageKind(url),
    },
    glossary,
    extraHeaders: await sessionHeaders(reviewProvider),
  });

  budget.segments += reviewed.review.reviewed;
  budget.chars += reviewed.usedChars;
  budget.at = Date.now();

  void logDebug({
    level: reviewed.review.failed ? 'warn' : 'info',
    event: reviewed.review.failed ? 'review.failed' : 'review.end',
    source: 'background',
    message: reviewed.review.failed ? '审校失败，保留主译文' : 'ok',
    data: {
      reviewed: reviewed.review.reviewed,
      corrected: reviewed.review.corrected,
      rejected: reviewed.rejected.length,
      truncated: reviewed.review.truncated || truncated,
      chars: reviewed.usedChars,
    },
  });

  return {
    ok: true,
    corrections: reviewed.corrections,
    rejected: reviewed.rejected,
    review: { ...reviewed.review, truncated: reviewed.review.truncated || truncated },
  };
}

/**
 * 只接受结构正确的送审项；content 是唯一来源，但消息通道不能假设输入可信。
 * @param {any} items
 * @returns {import('../types').ReviewRunItem[]}
 */
function sanitizeReviewItems(items) {
  if (!Array.isArray(items)) return [];
  /** @type {import('../types').ReviewRunItem[]} */
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? '').trim();
    const source = String(item.source ?? '');
    if (!id || !source.trim()) continue;
    out.push({
      id,
      source,
      primary: String(item.primary ?? ''),
      reasons: Array.isArray(item.reasons) ? item.reasons.map(String).slice(0, 8) : [],
      missing: Array.isArray(item.missing) ? item.missing.map(String).slice(0, 20) : [],
      ...(item.prev ? { prev: String(item.prev).slice(0, 200) } : {}),
      ...(item.next ? { next: String(item.next).slice(0, 200) } : {}),
    });
  }
  return out;
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
  /** @type {import('../types').TranslateBatchResult} */
  let result;
  try {
    result = await translateBatch({
      texts,
      config,
      target: settings.targetLang,
      targetCode: settings.targetLangCode,
      glossary: [],
      enforcement: 'warn',
      extraHeaders,
    });
  } catch (err) {
    markLogged(err);
    void logDebug({
      level: 'error',
      event: 'provider.test',
      source: 'background',
      message: String(/** @type {any} */ (err)?.message ?? err),
      data: {
        ...errorData(err),
        presetId: config.presetId,
        protocol: config.protocol,
        model: config.model,
        elapsed: Date.now() - started,
      },
    });
    throw err;
  }

  void logDebug({
    level: 'info',
    event: 'provider.test',
    source: 'background',
    message: 'ok',
    data: {
      presetId: config.presetId,
      protocol: config.protocol,
      model: config.model,
      elapsed: Date.now() - started,
    },
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
