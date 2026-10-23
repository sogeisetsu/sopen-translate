/**
 * Offscreen 文档：唯一能调用 Chrome 端侧 Translator API 的地方。
 *
 * 只处理 `builtin.translate` 消息；页面文本在这里翻译完就返回，
 * 不写存储、不联网。语言包缺失时 create() 会抛 NotAllowedError，
 * 这里转成可读提示，让用户去设置页点一次「准备语言包」。
 */

/** @type {Map<string, Promise<any>>} 语言对 → translator 实例（失败会从缓存删除） */
const translators = new Map();

/** @param {string} source @param {string} target */
function pairKey(source, target) {
  return `${source}\u0000${target}`;
}

/**
 * @param {string} sourceLanguage
 * @param {string} targetLanguage
 * @returns {Promise<any>}
 */
function getTranslator(sourceLanguage, targetLanguage) {
  const key = pairKey(sourceLanguage, targetLanguage);
  const cached = translators.get(key);
  if (cached) return cached;

  const created = (async () => {
    const TranslatorApi = /** @type {any} */ (globalThis).Translator;
    if (typeof TranslatorApi !== 'function') {
      throw new Error('当前浏览器没有内置翻译 API（需要桌面版 Chrome/Chromium）');
    }
    const availability = await TranslatorApi.availability({ sourceLanguage, targetLanguage });
    if (availability === 'unavailable') {
      throw new Error(`Chrome 内置翻译不支持 ${sourceLanguage} → ${targetLanguage}`);
    }
    if (availability === 'downloadable' || availability === 'downloading') {
      throw new Error('Chrome 内置翻译语言包尚未下载：请到设置页的该服务卡片点「准备语言包」');
    }
    return TranslatorApi.create({ sourceLanguage, targetLanguage });
  })();

  translators.set(key, created);
  created.catch(() => translators.delete(key));
  return created;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'builtin.translate') return false;

  (async () => {
    try {
      const texts = Array.isArray(message.texts) ? message.texts.map(String) : [];
      if (texts.length === 0) {
        sendResponse({ ok: true, translations: [] });
        return;
      }
      const translator = await getTranslator(
        String(message.sourceLanguage || 'en'),
        String(message.targetLanguage || 'zh'),
      );
      /** @type {string[]} */
      const translations = [];
      for (const text of texts) {
        translations.push(String(await translator.translate(text)));
      }
      sendResponse({ ok: true, translations });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      if (/NotAllowedError|user gesture/i.test(messageText)) {
        sendResponse({
          ok: false,
          error: 'Chrome 内置翻译需要先下载语言包：请到设置页的该服务卡片点「准备语言包」',
        });
      } else {
        sendResponse({ ok: false, error: messageText });
      }
    }
  })();

  return true;
});
