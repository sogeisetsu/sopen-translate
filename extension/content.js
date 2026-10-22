/**
 * Content script：只做整页翻译。
 *
 * 两种展示模式：
 * - `translation`（纯译文）：TreeWalker 收集文本节点，按字符预算分批，译文写回原节点；
 * - `bilingual`（双语）：按块元素收集文本，译文追加到块内末尾的 `span` 里，
 *   不新增兄弟 `div`（表格 / 列表结构不会被破坏）。
 *
 * 不变量：每一轮翻译都从「原文」出发——开始前先把上一轮的改动还原掉。
 * 否则 originals 里会混进译文，还原时就回不到原文了。
 */

(() => {
  const win = /** @type {Window & { __sopenTranslateLoaded?: boolean }} */ (window);
  if (win.__sopenTranslateLoaded) return;
  win.__sopenTranslateLoaded = true;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'CODE', 'PRE',
    'KBD', 'SAMP', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'SELECT', 'OPTION',
  ]);
  /** 双语模式的块级候选 */
  const BLOCK_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'DD', 'DT',
    'BLOCKQUOTE', 'FIGCAPTION',
  ]);
  /** 纯 div 页面：没有块级后代、且文本够长才算一块 */
  const LEAF_CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN']);
  const BLOCKISH_TAGS = new Set([
    'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'P', 'LI', 'UL', 'OL', 'TABLE', 'THEAD',
    'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'PRE', 'FIGURE', 'FORM', 'NAV', 'HEADER', 'FOOTER', 'ASIDE',
    'DL', 'DT', 'DD',
  ]);
  /** 块里只要出现这些后代就整块跳过：不把代码翻坏 */
  const CODEISH_TAGS = new Set([
    'PRE', 'CODE', 'KBD', 'SAMP', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'SVG', 'CANVAS', 'IFRAME', 'OBJECT',
  ]);

  // 按字符预算分批：20 段/批会让 Wikipedia 这种“几千个短节点”的页面发出上百个请求。
  // 默认值只给兜底；实际策略由 readPolicy() 按协议/预设决定。
  const BATCH_CHARS = 3000;
  const BATCH_ITEMS = 50;
  const MIN_TEXT_LEN = 2;
  const MAX_SEGMENT_CHARS = 1200;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const LEAF_CONTAINER_MIN_CHARS = 40;

  const state = {
    /** @type {'translation' | 'bilingual'} */
    mode: 'translation',
    /** @type {{ node: Text, text: string }[]} 纯译文用 */
    originals: [],
    /** @type {Element[]} 双语用 */
    injected: [],
    busy: false,
    progress: { done: 0, total: 0 },
  };

  /** @type {HTMLDivElement | null} */
  let toastEl = null;
  let toastTimer = 0;

  /** @param {unknown} err @returns {string} */
  const errorText = (err) => (err instanceof Error ? err.message : String(err));

  /* ------------------------------- 后台调用 ------------------------------- */

  /**
   * @param {string[]} texts
   * @returns {Promise<{ translations: string[], protected: number, warnings: { index: number, missing: string[] }[] }>}
   */
  async function requestTranslate(texts) {
    const res = await chrome.runtime.sendMessage({ type: 'translate', texts });
    if (!res) throw new Error('扩展后台没有响应，重新加载一下扩展');
    if (!res.ok) throw new Error(res.error || '翻译失败');
    const translations = Array.isArray(res.translations) ? res.translations : [];
    if (translations.length !== texts.length) {
      throw new Error(`翻译结果数量异常（${translations.length}/${texts.length}）`);
    }
    return {
      translations,
      protected: Number(res.protected) || 0,
      warnings: Array.isArray(res.warnings) ? res.warnings : [],
    };
  }

  /* ------------------------------- 并发调度 ------------------------------- */

  /**
   * 端点限流特性不同，批大小与并发不能一刀切：
   * - DeepL 单请求最多 50 条 text，但吞吐高，可以 4 路；
   * - OpenCode Go 限的是持续速率，少而大的批次更稳（实测 50 段 × 4 路会熔断）；
   * - 商汤 RPM 很低，1 路。
   * @returns {Promise<{ chars: number, items: number, concurrency: number }>}
   */
  async function readPolicy() {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'status' });
      const active = status?.active;
      if (active?.protocol === 'deepl') return { chars: 3000, items: 50, concurrency: 4 };
      if (active?.presetId === 'sensenova') return { chars: 4000, items: 200, concurrency: 1 };
      return { chars: 4000, items: 200, concurrency: 4 };
    } catch {
      return { chars: BATCH_CHARS, items: BATCH_ITEMS, concurrency: 4 };
    }
  }

  /**
   * 有限并发执行批次；顺序由调用方按 index 写回，不依赖完成顺序。
   * - 第 0 批失败立即中止（多半是配置问题）
   * - 连续 3 批失败熔断，已完成的批次保留
   * @template T
   * @param {T[]} jobs
   * @param {(job: T, index: number) => Promise<void>} worker
   * @param {number} concurrency
   * @returns {Promise<{ stopped: boolean }>}
   */
  async function runPool(jobs, worker, concurrency) {
    let next = 0;
    let consecutiveFailures = 0;
    let stopped = false;
    /** @type {unknown} */
    let firstError = null;

    async function lane() {
      for (;;) {
        if (stopped) return;
        const index = next;
        next += 1;
        if (index >= jobs.length) return;
        try {
          await worker(jobs[index], index);
          consecutiveFailures = 0;
        } catch (err) {
          consecutiveFailures += 1;
          if (index === 0) {
            stopped = true;
            firstError = err;
            return;
          }
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            stopped = true;
            return;
          }
        }
      }
    }

    const lanes = Math.max(1, Math.min(concurrency, jobs.length));
    await Promise.all(Array.from({ length: lanes }, lane));
    if (firstError) throw firstError;
    return { stopped };
  }

  /* --------------------------------- 状态条 -------------------------------- */

  /** @returns {HTMLDivElement} */
  function ensureToast() {
    if (toastEl?.isConnected) return toastEl;

    const host = document.createElement('div');
    host.id = 'sopen-translate-ui';

    toastEl = document.createElement('div');
    toastEl.className = 'sopen-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
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
   * @param {{ chars?: number, items?: number }} [policy]
   * @returns {Text[][]}
   */
  function batchNodes(nodes, policy = {}) {
    const maxChars = policy.chars ?? BATCH_CHARS;
    const maxItems = policy.items ?? BATCH_ITEMS;
    /** @type {Text[][]} */
    const batches = [];
    /** @type {Text[]} */
    let current = [];
    let chars = 0;

    for (const node of nodes) {
      const len = (node.nodeValue || '').trim().length;
      if (current.length > 0 && (chars + len > maxChars || current.length >= maxItems)) {
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

  /* ------------------------------ 块收集（双语） ------------------------------ */

  /** @param {Element | null | undefined} el @returns {Element[]} */
  function elementChildren(el) {
    const raw = el?.children;
    if (!raw) return [];
    return Array.from(raw).filter((child) => child && child.nodeType === 1);
  }

  /** @param {Element} el @returns {boolean} */
  function isUnwalkable(el) {
    if (!el || el.nodeType !== 1) return true;
    const html = /** @type {HTMLElement} */ (el);
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (html.isContentEditable) return true;
    if (html.hidden) return true;
    if (el.getAttribute?.('aria-hidden') === 'true') return true;
    if (el.id === 'sopen-translate-ui') return true;
    if (el.closest?.('#sopen-translate-ui')) return true;
    if (el.hasAttribute?.('data-sopen-translated')) return true;
    return false;
  }

  /**
   * @param {Element} el
   * @param {Set<string>} tags
   * @returns {boolean}
   */
  function hasDescendantTag(el, tags) {
    for (const child of elementChildren(el)) {
      if (tags.has(child.tagName)) return true;
      if (hasDescendantTag(child, tags)) return true;
    }
    return false;
  }

  /**
   * @param {Element} el
   * @param {Set<Element>} candidates
   * @returns {boolean}
   */
  function hasInnerCandidate(el, candidates) {
    for (const child of elementChildren(el)) {
      if (candidates.has(child)) return true;
      if (hasInnerCandidate(child, candidates)) return true;
    }
    return false;
  }

  /** @param {Element} el @returns {boolean} 已注入的译文块不能让下一轮再翻一遍 */
  function containsInjected(el) {
    for (const child of elementChildren(el)) {
      if (child.classList?.contains?.('sopen-translated-block')) return true;
      if (child.hasAttribute?.('data-sopen-translated')) return true;
      if (containsInjected(child)) return true;
    }
    return false;
  }

  /** @param {Element} el @returns {string} */
  function blockText(el) {
    const html = /** @type {HTMLElement} */ (el);
    const inner = typeof html.innerText === 'string' ? html.innerText : '';
    const raw = inner || el.textContent || '';
    return raw.replace(/\u00a0/g, ' ').trim();
  }

  /**
   * @param {Element} [root]
   * @returns {{ el: Element, text: string }[]}
   */
  function collectBlocks(root = document.body) {
    if (!root) return [];

    /** @type {Element[]} */
    const candidates = [];
    /** @param {Element} el */
    const visit = (el) => {
      for (const child of elementChildren(el)) {
        if (isUnwalkable(child)) continue;
        if (BLOCK_TAGS.has(child.tagName) || LEAF_CONTAINER_TAGS.has(child.tagName)) {
          candidates.push(child);
        }
        visit(child);
      }
    };
    visit(root);

    const candidateSet = new Set(candidates);
    /** @type {{ el: Element, text: string }[]} */
    const blocks = [];

    for (const el of candidates) {
      // 父级里还有候选（<li><p>…</p></li>）就交给子级
      if (hasInnerCandidate(el, candidateSet)) continue;
      if (containsInjected(el)) continue;
      if (hasDescendantTag(el, CODEISH_TAGS)) continue;

      const isLeafContainer = LEAF_CONTAINER_TAGS.has(el.tagName);
      if (isLeafContainer && hasDescendantTag(el, BLOCKISH_TAGS)) continue;

      const text = blockText(el);
      if (text.length < MIN_TEXT_LEN) continue;
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      if (isLeafContainer && text.length < LEAF_CONTAINER_MIN_CHARS) continue;

      blocks.push({ el, text });
    }
    return blocks;
  }

  /* ------------------------------ 长块切分 ------------------------------ */

  /** @param {string} text @returns {boolean} CJK 文字或全角标点结尾都不加空格 */
  function endsWithCjk(text) {
    const last = text.slice(-1);
    return /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(last);
  }

  /**
   * 拼接译文分片：CJK 结尾不加空格，拉丁结尾加空格。
   * @param {string[]} parts
   * @returns {string}
   */
  function joinChunks(parts) {
    let out = '';
    for (const part of parts) {
      const piece = String(part ?? '').trim();
      if (!piece) continue;
      if (!out) {
        out = piece;
        continue;
      }
      out += endsWithCjk(out) ? piece : ` ${piece}`;
    }
    return out;
  }

  /**
   * 按句切到 ≤ max 字符；单句超长时硬切。
   * @param {string} text
   * @param {number} [max]
   * @returns {string[]}
   */
  function splitLongText(text, max = MAX_SEGMENT_CHARS) {
    const source = String(text ?? '').trim();
    if (!source) return [];
    if (source.length <= max) return [source];

    const sentences = source
      .split(/(?<=[。！？!?;；])\s*|\n+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    /** @type {string[]} */
    const pieces = [];
    for (const sentence of sentences) {
      if (sentence.length <= max) {
        pieces.push(sentence);
      } else {
        for (let i = 0; i < sentence.length; i += max) pieces.push(sentence.slice(i, i + max));
      }
    }

    /** @type {string[]} */
    const chunks = [];
    let current = '';
    for (const piece of pieces) {
      if (current && current.length + piece.length + 1 > max) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? joinChunks([current, piece]) : piece;
      }
    }
    if (current) chunks.push(current);
    return chunks.map((chunk) => chunk.trim()).filter(Boolean);
  }

  /**
   * @param {{ el: Element, text: string }[]} blocks
   * @returns {{ text: string, blockIndex: number, chunkIndex: number }[]}
   */
  function buildSegments(blocks) {
    /** @type {{ text: string, blockIndex: number, chunkIndex: number }[]} */
    const segments = [];
    blocks.forEach((block, blockIndex) => {
      splitLongText(block.text).forEach((text, chunkIndex) => {
        segments.push({ text, blockIndex, chunkIndex });
      });
    });
    return segments;
  }

  /**
   * @param {{ text: string }[]} segments
   * @param {{ chars?: number, items?: number }} [policy]
   * @returns {{ text: string }[][]}
   */
  function batchSegments(segments, policy = {}) {
    const maxChars = policy.chars ?? BATCH_CHARS;
    const maxItems = policy.items ?? BATCH_ITEMS;
    /** @type {{ text: string }[][]} */
    const batches = [];
    /** @type {{ text: string }[]} */
    let current = [];
    let chars = 0;

    for (const segment of segments) {
      const len = segment.text.length;
      if (current.length > 0 && (chars + len > maxChars || current.length >= maxItems)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(segment);
      chars += len;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  /* ------------------------------- 写回 / 插入 ------------------------------- */

  /**
   * @param {Text[]} nodes
   * @param {string[]} translations
   * @returns {number}
   */
  function applyTextTranslations(nodes, translations) {
    let count = 0;
    nodes.forEach((node, position) => {
      const next = translations[position];
      const from = node.nodeValue || '';
      if (typeof next !== 'string' || !next.trim()) return;
      if (next.trim() === from.trim()) return;
      node.nodeValue = from.replace(from.trim(), next.trim());
      state.originals.push({ node, text: from });
      count += 1;
    });
    return count;
  }

  /**
   * 译文追加到块内末尾（`append`，不是兄弟 `div`），表格 / 列表结构安全。
   * @param {{ el: Element, text: string }[]} blocks
   * @param {{ blockIndex: number, chunkIndex: number }[]} segments
   * @param {string[]} translations
   * @returns {number} 插入的块数
   */
  function applyBlockTranslations(blocks, segments, translations) {
    /** @type {Map<number, string[]>} */
    const byBlock = new Map();
    segments.forEach((segment, index) => {
      const parts = byBlock.get(segment.blockIndex) || [];
      parts[segment.chunkIndex] = translations[index] ?? '';
      byBlock.set(segment.blockIndex, parts);
    });

    let inserted = 0;
    blocks.forEach((block, blockIndex) => {
      const parts = byBlock.get(blockIndex);
      if (!parts || parts.length === 0) return;
      // 有 chunk 没翻出来就整块跳过，不要把半截译文拼上去
      if (parts.some((part) => typeof part !== 'string' || !part.trim())) return;

      const text = joinChunks(parts).trim();
      if (!text) return;
      // 术语回退时译文可能等于原文：不要再复制一份
      if (text === block.text.trim()) return;

      const span = document.createElement('span');
      span.className = 'sopen-translated-block';
      span.setAttribute('data-sopen-translated', '');
      span.style.display = 'block';
      span.textContent = text;

      if (typeof block.el.append === 'function') block.el.append(span);
      else block.el.appendChild(span);

      state.injected.push(span);
      inserted += 1;
    });
    return inserted;
  }

  /* ------------------------------- 还原 ------------------------------- */

  function resetPage() {
    for (const el of state.injected) {
      if (typeof el.remove === 'function') el.remove();
      else el.parentElement?.removeChild?.(el);
    }
    state.injected = [];
    for (const { node, text } of state.originals) node.nodeValue = text;
    state.originals = [];
    state.progress = { done: 0, total: 0 };
  }

  function restorePage() {
    if (state.busy) return { ok: false, error: '正在翻译中，等这一轮结束再还原' };
    const count = state.injected.length + state.originals.length;
    resetPage();
    hideToast();
    return { ok: true, restored: count };
  }

  /* ------------------------------- 展示模式 ------------------------------- */

  /** @returns {Promise<'translation' | 'bilingual'>} */
  async function readDisplayMode() {
    try {
      const data = /** @type {{ settings?: { displayMode?: string } }} */ (
        await chrome.storage.local.get('settings')
      );
      return data.settings?.displayMode === 'bilingual' ? 'bilingual' : 'translation';
    } catch {
      return 'translation';
    }
  }

  function progressText() {
    const label = state.mode === 'bilingual' ? '翻译中（双语）' : '翻译中';
    return `${label} ${state.progress.done}/${state.progress.total}…`;
  }

  /**
   * @param {string} prefix
   * @param {{ failed: number, protected: number, warnings: number, stopped: boolean }} summary
   */
  function summaryText(prefix, { failed, protected: protectedCount, warnings, stopped }) {
    const parts = [prefix];
    if (failed > 0) parts.push(`${failed} 段失败`);
    if (protectedCount > 0) parts.push(`${protectedCount} 段保留原文`);
    if (warnings > 0) parts.push(`${warnings} 段可能未保留术语`);
    if (stopped) parts.push('连续失败，已停止');
    return parts.join('，');
  }

  /* ------------------------------- 纯译文 ------------------------------- */

  async function translateTextMode() {
    const nodes = collectTextNodes();
    if (nodes.length === 0) {
      showToast('这一页没找到可翻译的文本', { timeout: 2500 });
      return { ok: false, error: '没有可翻译的文本' };
    }

    state.progress = { done: 0, total: nodes.length };
    const policy = await readPolicy();
    const batches = batchNodes(nodes, policy);
    let translated = 0;
    let failed = 0;
    let protectedCount = 0;
    let warnings = 0;

    try {
      const { stopped } = await runPool(
        batches,
        async (batch) => {
          showToast(progressText());
          try {
            const result = await requestTranslate(
              batch.map((node) => (node.nodeValue || '').trim()),
            );
            protectedCount += result.protected;
            warnings += result.warnings.length;
            translated += applyTextTranslations(batch, result.translations);
            state.progress.done += batch.length;
          } catch (err) {
            failed += batch.length;
            state.progress.done += batch.length;
            throw err;
          }
        },
        policy.concurrency,
      );

      showToast(
        summaryText(`已翻译 ${translated} 段`, {
          failed,
          protected: protectedCount,
          warnings,
          stopped,
        }),
        { timeout: 3000 },
      );
      return { ok: true, translated, failed, protected: protectedCount, stopped };
    } catch (err) {
      showToast(`翻译失败：${errorText(err)}`, { error: true, timeout: 5000 });
      return { ok: false, error: errorText(err) };
    }
  }

  /* ------------------------------- 双语 ------------------------------- */

  async function translateBilingual() {
    const blocks = collectBlocks();
    const segments = buildSegments(blocks);
    if (segments.length === 0) {
      showToast('这一页没找到可翻译的文本', { timeout: 2500 });
      return { ok: false, error: '没有可翻译的文本' };
    }

    state.progress = { done: 0, total: segments.length };
    const policy = await readPolicy();
    const batches = batchSegments(segments, policy);
    /** @type {{ items: { text: string }[], offset: number }[]} */
    const jobs = [];
    let offset = 0;
    for (const items of batches) {
      jobs.push({ items, offset });
      offset += items.length;
    }
    /** @type {string[]} */
    const translations = new Array(segments.length).fill('');
    let failed = 0;
    let protectedCount = 0;
    let warnings = 0;

    try {
      const { stopped } = await runPool(
        jobs,
        async (job) => {
          showToast(progressText());
          try {
            const result = await requestTranslate(job.items.map((segment) => segment.text));
            result.translations.forEach((text, position) => {
              translations[job.offset + position] = text;
            });
            protectedCount += result.protected;
            warnings += result.warnings.length;
            state.progress.done += job.items.length;
          } catch (err) {
            failed += job.items.length;
            state.progress.done += job.items.length;
            throw err;
          }
        },
        policy.concurrency,
      );

      const translated = applyBlockTranslations(blocks, segments, translations);
      showToast(
        summaryText(`已翻译 ${translated} 块`, {
          failed,
          protected: protectedCount,
          warnings,
          stopped,
        }),
        { timeout: 3000 },
      );
      return { ok: true, translated, failed, protected: protectedCount, stopped };
    } catch (err) {
      showToast(`翻译失败：${errorText(err)}`, { error: true, timeout: 5000 });
      return { ok: false, error: errorText(err) };
    }
  }

  /* ------------------------------- 整页翻译 ------------------------------- */

  async function translatePage() {
    if (state.busy) return { ok: false, error: '正在翻译中' };

    // 先占住 busy：读模式是异步的，不先占住会让连点两次都通过检查
    state.busy = true;
    try {
      // 每轮都从原文出发：上一轮没还原就先还原，避免译文被二次翻译
      resetPage();
      state.mode = await readDisplayMode();
      return state.mode === 'bilingual'
        ? await translateBilingual()
        : await translateTextMode();
    } finally {
      state.busy = false;
    }
  }

  /* ------------------------------- 消息入口 ------------------------------- */

  /** 两种模式互斥（每轮开始都会 resetPage），相加就是当前页面上的译文总数 */
  function translatedCount() {
    const injected = state.injected.filter((el) => el.isConnected !== false).length;
    return state.originals.length + injected;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'page.translate':
        translatePage().then(sendResponse);
        return true;
      case 'page.restore':
        sendResponse(restorePage());
        return false;
      case 'page.status':
        sendResponse({
          ok: true,
          translated: translatedCount(),
          busy: state.busy,
          mode: state.mode,
          progress: state.progress,
        });
        return false;
      default:
        return false;
    }
  });
})();
