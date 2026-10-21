/**
 * Content script：只负责 DOM。
 * 全页翻译走 TreeWalker 收集文本节点，按字符预算分批交给 background，
 * 原文存起来，随时可以还原。
 */

(() => {
  if (window.__sopenTranslateLoaded) return;
  window.__sopenTranslateLoaded = true;

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
  let ui = null;

  /* ------------------------------- 后台调用 ------------------------------- */

  async function requestTranslate(texts) {
    const res = await chrome.runtime.sendMessage({ type: 'translate', texts });
    if (!res) throw new Error('扩展后台没有响应，重新加载一下扩展');
    if (!res.ok) throw new Error(res.error || '翻译失败');
    return res.translations;
  }

  /* --------------------------------- UI --------------------------------- */

  function ensureUi() {
    if (ui) return ui;

    const host = document.createElement('div');
    host.id = 'sopen-translate-ui';
    host.addEventListener('mousedown', (e) => e.stopPropagation());
    host.addEventListener('mouseup', (e) => e.stopPropagation());

    const toast = document.createElement('div');
    toast.className = 'sopen-toast';
    toast.hidden = true;

    const bubble = document.createElement('button');
    bubble.className = 'sopen-bubble';
    bubble.type = 'button';
    bubble.textContent = '译';
    bubble.hidden = true;

    const panel = document.createElement('div');
    panel.className = 'sopen-panel';
    panel.hidden = true;
    panel.innerHTML =
      '<div class="sopen-panel-head"><span class="sopen-panel-title">翻译</span>' +
      '<button type="button" class="sopen-close" aria-label="关闭">×</button></div>' +
      '<div class="sopen-panel-body"></div>';

    host.append(bubble, panel, toast);
    document.documentElement.appendChild(host);

    ui = { host, toast, bubble, panel, body: panel.querySelector('.sopen-panel-body') };
    ui.panel.querySelector('.sopen-close').addEventListener('click', () => hidePanel());
    bubble.addEventListener('click', () => {
      const text = bubble.dataset.text || '';
      const rect = JSON.parse(bubble.dataset.rect || '{"top":0,"bottom":40,"left":0}');
      hideBubble();
      if (text) showPanelTranslation(text, rect);
    });

    return ui;
  }

  function isOurs(target) {
    return !!(target && target.closest && target.closest('#sopen-translate-ui'));
  }

  function showToast(text, { error = false, timeout = 0 } = {}) {
    const { toast } = ensureUi();
    toast.textContent = text;
    toast.hidden = false;
    toast.classList.toggle('is-error', error);
    clearTimeout(showToast.timer);
    if (timeout) showToast.timer = setTimeout(() => (toast.hidden = true), timeout);
  }

  function hideToast() {
    if (ui) ui.toast.hidden = true;
  }

  function showBubble(rect, text) {
    const { bubble } = ensureUi();
    bubble.dataset.text = text;
    bubble.dataset.rect = JSON.stringify({
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
    });
    bubble.hidden = false;
    const top = Math.max(8, rect.top - 34);
    const left = Math.min(window.innerWidth - 44, Math.max(8, rect.left + rect.width / 2 - 14));
    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;
  }

  function hideBubble() {
    if (ui) {
      ui.bubble.hidden = true;
      ui.bubble.dataset.text = '';
    }
  }

  function showPanel(anchorRect, content) {
    const { panel, body } = ensureUi();
    body.replaceChildren();
    if (typeof content === 'string') body.textContent = content;
    else body.append(content);

    panel.hidden = false;
    panel.style.top = `${Math.min(window.innerHeight - 140, anchorRect.bottom + 10)}px`;
    panel.style.left = `${Math.max(8, Math.min(window.innerWidth - 360, anchorRect.left))}px`;
  }

  function hidePanel() {
    if (ui) ui.panel.hidden = true;
  }

  async function showPanelTranslation(text, rect) {
    const loading = document.createElement('span');
    loading.className = 'sopen-loading';
    loading.textContent = '翻译中…';
    showPanel(rect, loading);

    try {
      const [translated] = await requestTranslate([text]);
      showPanel(rect, translated);
    } catch (err) {
      showPanel(rect, `翻译失败：${err.message}`);
    }
  }

  /* ------------------------------ 划词翻译 ------------------------------ */

  document.addEventListener('mouseup', (event) => {
    if (isOurs(event.target)) return;

    const selection = window.getSelection();
    const text = selection?.toString().trim() || '';
    if (text.length < MIN_TEXT_LEN || !selection.rangeCount) {
      hideBubble();
      return;
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      hideBubble();
      return;
    }
    showBubble(rect, text);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideBubble();
      hidePanel();
    }
  });

  /* ------------------------------ 整页翻译 ------------------------------ */

  function collectTextNodes(root = document.body) {
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

    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  /** 按字符预算把节点切成批，尽量不打断段落语境 */
  function batchNodes(nodes) {
    const batches = [];
    let current = [];
    let chars = 0;

    for (const node of nodes) {
      const len = node.nodeValue.trim().length;
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
        const texts = batch.map((node) => node.nodeValue.trim());
        showToast(`翻译中 ${done}/${nodes.length}…`);

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
          if (typeof next !== 'string' || !next.trim()) return;
          if (next.trim() === node.nodeValue.trim()) return;
          const from = node.nodeValue;
          node.nodeValue = from.replace(from.trim(), next.trim());
          originals.push({ node, text: from });
        });

        done += batch.length;
      }

      showToast(`已翻译 ${originals.length} 段${failed ? `，${failed} 段失败` : ''}`, { timeout: 3000 });
      return { ok: true, translated: originals.length, failed };
    } catch (err) {
      showToast(`翻译失败：${err.message}`, { error: true, timeout: 5000 });
      return { ok: false, error: err.message };
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
