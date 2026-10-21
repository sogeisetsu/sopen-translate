/**
 * Service worker：唯一的出网口。
 * 密钥只在这里被读出来用，content script 永远看不到。
 */

import { getActiveProvider, getSettings } from './lib/settings.js';
import { getProviderType } from './lib/providers.js';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const settings = await getSettings();
  if (settings.providers.length === 0) chrome.runtime.openOptionsPage();
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
    default:
      return null;
  }
}

function normalizeTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) throw new Error('没有要翻译的文本');
  return texts.map((t) => String(t ?? ''));
}

async function translate(texts) {
  const list = normalizeTexts(texts);
  const { settings, provider } = await getActiveProvider();
  if (!provider) throw new Error('还没有配置翻译服务，先去设置页添加一个');

  const type = getProviderType(provider.type);
  const translations = await type.translate({
    texts: list,
    config: provider,
    target: settings.targetLang,
    targetCode: settings.targetLangCode,
  });

  if (translations.length !== list.length) {
    throw new Error(`翻译结果数量异常（${translations.length}/${list.length}）`);
  }
  return { ok: true, translations };
}

async function testProvider(config, sample) {
  if (!config) throw new Error('缺少服务配置');
  const settings = await getSettings();
  const type = getProviderType(config.type);
  const texts = [sample || 'Hello, world.'];

  const started = Date.now();
  const [translated] = await type.translate({
    texts,
    config,
    target: settings.targetLang,
    targetCode: settings.targetLangCode,
  });

  return {
    ok: true,
    result: translated,
    elapsed: Date.now() - started,
    provider: type.label,
  };
}

async function status() {
  const settings = await getSettings();
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  return {
    ok: true,
    providerCount: settings.providers.length,
    active: provider ? { label: provider.label, type: provider.type } : null,
    targetLang: settings.targetLang,
  };
}
