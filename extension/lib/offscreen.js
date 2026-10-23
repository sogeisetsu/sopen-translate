/**
 * Chrome 端侧内置翻译（Translator API）的 offscreen 桥。
 *
 * 为什么需要 offscreen：Translator API 只暴露在顶层 window / same-origin iframe，
 * **不在 Web Worker / service worker 里**。background 因此通过一个隐藏的
 * `offscreen.html` 文档调用它；这段代码本身不联网，页面文本不出本机。
 *
 * 首次使用某个语言对时，需要用户在设置页点击「准备语言包」完成一次带
 * user activation 的下载；之后 offscreen 里的 create() 可以直接复用。
 *
 * @typedef {import('../../types').ProtocolBuildArgs} ProtocolBuildArgs
 */

/** @type {Promise<void> | null} */
let creating = null;

/** 确保 offscreen 文档存在；重复调用会复用同一个创建 Promise。 */
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (contexts.length > 0) return;
  }
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Run the browser built-in Translator API for page translation.',
      })
      .catch((err) => {
        // 并发/旧版 Chrome 可能报“只能有一个 offscreen 文档”：已存在就复用
        if (!/single offscreen|only one offscreen/i.test(String(err))) throw err;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

/**
 * @param {{ texts: string[], sourceLanguage: string, targetLanguage: string }} args
 * @returns {Promise<string[]>}
 */
export async function translateWithBuiltin({ texts, sourceLanguage, targetLanguage }) {
  if (typeof chrome === 'undefined' || !chrome.offscreen) {
    throw new Error('当前环境不支持 Chrome 内置翻译（需要 Chrome/Chromium 扩展环境）');
  }
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    type: 'builtin.translate',
    sourceLanguage,
    targetLanguage,
    texts,
  });
  if (!res?.ok) throw new Error(res?.error || 'Chrome 内置翻译失败');
  const translations = Array.isArray(res.translations) ? res.translations.map(String) : [];
  if (translations.length !== texts.length) {
    throw new Error(`Chrome 内置翻译返回数量不符（${translations.length}/${texts.length}）`);
  }
  return translations;
}
