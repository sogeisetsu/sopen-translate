/**
 * Content script：只做整页翻译。
 * 用 TreeWalker 收集文本节点，按字符预算分批交给 background，
 * 原文留一份，随时可还原。
 */

(() => {
  const win = /** @type {Window & { __sopenTranslateLoaded?: boolean }} */ (window);
  if (win.__sopenTranslateLoaded) return;
  win.__sopenTranslateLoaded = true;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'CODE', 'PRE',
    'KBD', 'SAMP', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT',
  ]);
  const BATCH_CHARS = 1200;
  const BATCH_ITEMS = 20;
  const MIN_TEXT_LEN = 2;

  /** @type {{ node: Text, text: string }[]} */
  let originals = [];
  let busy = false;

  /** @type {HTMLDivElement | null} */
  let toastEl = null;
  let toastTimer = 0;

  /** @param {unknown} err @returns {string} */
  const errorText = (err) => (err instanceof Error ? err.message : String(err));

  /* ------------------------------- 后台调用 ------------------------------- */

  /** @param {string[]} texts @returns {Promise<string[]>} */
  async function requestTranslate(texts) {
    const res = await chrome.runtime.sendMessage({ type: 'translate', texts });
    if (!res) throw new Error('扩展后台没有响应，重新加载一下扩展');
    if (!res.ok) throw new Error(res.error || '翻译失败');
    return res.translations;
  }

  /* --------------------------------- 状态条 -------------------------------- */

  /** @returns {HTMLDivElement} */
  function ensureToast() {
    if (toastEl?.isConnected) return toastEl;

    const host = document.createElement('div');
    host.id = 'sopen-translate-ui';

    toastEl = document.createElement('div');
    toastEl.className = 'sopen-toast';
    toastEl.hidden = true;

    host.append(toastEl);
    document.documentElement.appendChild(host);
    return toastEl;
  }

  /**
   * @param {string} text
   * @param {{ error?: boolean, timeout?: number }} [options]
   */
  function showToast(text, { error = false, timeout = 0 } = {}) {
    const el = ensureToast();
    el.textContent = text;
    el.hidden = false;
    el.classList.toggle('is-error', error);
    clearTimeout(toastTimer);
    if (timeout) toastTimer = setTimeout(() => (el.hidden = true), timeout);
  }

  function hideToast() {
    if (toastEl) toastEl.hidden = true;
  }

  /* ------------------------------ 文本节点收集 ------------------------------ */

  /**
   * @param {Element} [root]
   * @returns {Text[]}
   */
  function collectTextNodes(root = document.body) {
    /** @type {Text[]} */
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('#sopen-translate-ui')) return NodeFilter.FILTER_REJECT;
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        const text = node.nodeValue?.trim() || '';
        if (text.length < MIN_TEXT_LEN) return NodeFilter.FILTER_REJECT;
        if (!/[\p{L}\p{N}]/u.test(text)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode()) nodes.push(/** @type {Text} */ (walker.currentNode));
    return nodes;
  }

  /**
   * 按字符预算把节点切成批，尽量不打断段落语境
   * @param {Text[]} nodes
   * @returns {Text[][]}
   */
  function batchNodes(nodes) {
    /** @type {Text[][]} */
    const batches = [];
    /** @type {Text[]} */
    let current = [];
    let chars = 0;

    for (const node of nodes) {
      const len = (node.nodeValue || '').trim().length;
      if (current.length > 0 && (chars + len > BATCH_CHARS || current.length >= BATCH_ITEMS)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(node);
      chars += len;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  /* ------------------------------- 整页翻译 ------------------------------- */

  async function translatePage() {
    if (busy) return { ok: false, error: '正在翻译中' };

    const nodes = collectTextNodes();
    if (nodes.length === 0) {
      showToast('这一页没找到可翻译的文本', { timeout: 2500 });
      return { ok: false, error: '没有可翻译的文本' };
    }

    busy = true;
    const batches = batchNodes(nodes);
    let done = 0;
    let failed = 0;

    try {
      for (const batch of batches) {
        const texts = batch.map((node) => (node.nodeValue || '').trim());
        showToast(`翻译中 ${done}/${nodes.length}…`);

        /** @type {string[]} */
        let translations;
        try {
          translations = await requestTranslate(texts);
        } catch (err) {
          failed += batch.length;
          done += batch.length;
          // 一段都没翻成时直接放弃：多半是配置问题，别把半页留着耗额度
          if (originals.length === 0) throw err;
          continue;
        }

        batch.forEach((node, index) => {
          const next = translations[index];
          const from = node.nodeValue || '';
          if (typeof next !== 'string' || !next.trim()) return;
          if (next.trim() === from.trim()) return;
          node.nodeValue = from.replace(from.trim(), next.trim());
          originals.push({ node, text: from });
        });

        done += batch.length;
      }

      showToast(`已翻译 ${originals.length} 段${failed ? `，${failed} 段失败` : ''}`, {
        timeout: 3000,
      });
      return { ok: true, translated: originals.length, failed };
    } catch (err) {
      showToast(`翻译失败：${errorText(err)}`, { error: true, timeout: 5000 });
      return { ok: false, error: errorText(err) };
    } finally {
      busy = false;
    }
  }

  function restorePage() {
    for (const { node, text } of originals) {
      try {
        node.nodeValue = text;
      } catch {
        /* 节点可能已被页面移除 */
      }
    }
    const count = originals.length;
    originals = [];
    hideToast();
    return { ok: true, restored: count };
  }

  /* ------------------------------- 消息入口 ------------------------------- */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'page.translate':
        translatePage().then(sendResponse);
        return true;
      case 'page.restore':
        sendResponse(restorePage());
        return false;
      case 'page.status':
        sendResponse({ ok: true, translated: originals.length, busy });
        return false;
      default:
        return false;
    }
  });
})();
