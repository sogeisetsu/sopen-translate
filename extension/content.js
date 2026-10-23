/**
 * Content script：只做整页翻译。
 *
 * 两种展示模式：
 * - `translation`（纯译文）：TreeWalker 收集文本节点，按字符预算分批，译文写回原节点；
 * - `bilingual`（双语）：按块元素收集文本，译文追加到块内末尾的 `span` 里，
 *   不新增兄弟 `div`（表格 / 列表结构不会被破坏）。
 *
 * 两种范围：
 * - `viewport`（默认）：先翻当前视口 + 500px 余量，滚动 / 尺寸变化 / SPA 重渲染时继续补翻；
 * - `whole`：一次性整页翻译，保持旧行为。
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
  /** 失败批补跑的并发：主趟结束后限流通常已冷却 */
  const RETRY_CONCURRENCY = 2;
  const LEAF_CONTAINER_MIN_CHARS = 40;

  /** 异步审校：批次合并窗口、失败退避、diff 上限、单批送审上限 */
  const REVIEW_DEBOUNCE_MS = 400;
  const REVIEW_RETRY_MS = 1500;
  const REVIEW_LOG_MAX = 100;
  const REVIEW_QUEUE_MAX = 200;

  /** 视口判定的上下余量：比一屏多一点，滚动时几乎不用等 */
  const VIEWPORT_MARGIN = 500;
  const SCROLL_THROTTLE_MS = 200;
  const MUTATION_DEBOUNCE_MS = 500;
  /**
   * 视口首屏 / 续翻按“尽快出第一批”切，而不是按整页吞吐切：
   * 8000 字符 / 400 段会变成单个大请求，首屏要等整批返回；
   * 拆成多个小批后用同一并发数并行，第一批明显更快。
   * 整页模式仍用 provider 策略。
   */
  const VIEWPORT_BATCH_CHARS = 2000;
  const VIEWPORT_BATCH_ITEMS = 60;

  /** @typedef {{ chars: number, items: number, concurrency: number }} Policy */
  /** @typedef {{ el: Element, text: string }} Block */

  /**
   * @typedef {{ kind: 'text', node: Text, primaryFull: string, appliedFull: string | null }
   *   | { kind: 'block', el: Element, chunkIndex: number }} ReviewTarget
   */

  const state = {
    /** @type {'translation' | 'bilingual'} */
    mode: 'translation',
    /** @type {'viewport' | 'whole'} */
    scope: 'viewport',
    /** @type {{ node: Text, text: string }[]} 纯译文用 */
    originals: [],
    /** @type {Element[]} 双语用 */
    injected: [],
    busy: false,
    progress: { done: 0, total: 0 },
    /** 已经成功处理过的节点 / 块：滚动补翻时不再送一遍 */
    /** @type {WeakSet<Text>} */
    seenNodes: new WeakSet(),
    /** @type {WeakSet<Element>} */
    seenBlocks: new WeakSet(),
    /** 视口外、等待滚动的候选 */
    /** @type {Text[]} */
    pendingNodes: [],
    /** @type {Block[]} */
    pendingBlocks: [],
    /** 已进入 pending 的成员，避免 MutationObserver 重复入队 */
    /** @type {WeakSet<Text>} */
    queuedNodes: new WeakSet(),
    /** @type {WeakSet<Element>} */
    queuedBlocks: new WeakSet(),
    /** 是否还有可见但未处理的候选（page.status 用） */
    pending: false,
    /** 标签页隐藏时暂停补翻 */
    paused: false,
    /** 当前有任务在跑时，滚动的补扫请求合并到这一轮之后 */
    pendingScan: false,
    scanTimer: 0,
    /** @type {(() => void)[]} */
    cleanups: [],
    /** @type {Policy | null} */
    policy: null,
    /** 本轮页面翻译的 token：后台按它累计审校预算，还原/重新翻译时换新的 */
    pageToken: '',
    /** 本轮的目标语言：审校请求要用，跟主翻译保持同一代设置 */
    target: '',
    targetCode: '',
    /** 设置里的样本开关；每轮只读一次，避免每条日志都问后台 */
    debugSamples: false,
    /**
     * 审校代次：每次 resetPage 递增。晚到的 review 响应 generation 不一致就丢弃，
     * 否则会出现“已还原的页面上又被写回一句译文”。
     */
    generation: 0,
    /** @type {Map<string, ReviewTarget>} id → DOM 目标，补丁/撤销都按它找 */
    reviewTargets: new Map(),
    /** @type {WeakMap<Text, string>} */
    textIds: new WeakMap(),
    /** @type {WeakMap<Element, string>} */
    blockIds: new WeakMap(),
    /** @type {Map<Element, string[]>} 双语：每块的译文分片（修正后重新 join） */
    blockTranslations: new Map(),
    /** @type {Map<Element, HTMLElement>} 双语：已插入的译文 span */
    blockSpans: new Map(),
    /** @type {Map<Element, string>} 双语：块内原文，修正后可插入原本没插入的块 */
    blockSources: new Map(),
    idSeq: 0,
    /** @type {import('../types').ReviewRunItem[]} */
    reviewQueue: [],
    reviewTimer: 0,
    reviewInFlight: false,
    /** 同一批失败最多退避重试一次 */
    reviewAttempts: 0,
    /** @type {import('../types').ReviewLogEntry[]} */
    reviewLog: [],
    /** @type {import('../types').ReviewStatus} */
    review: { pending: false, reviewed: 0, corrected: 0, failed: false, truncated: false },
  };

  /** @type {HTMLDivElement | null} */
  let toastEl = null;
  let toastTimer = 0;

  /** @param {unknown} err @returns {string} */
  const errorText = (err) => (err instanceof Error ? err.message : String(err));

  /* ------------------------------- 调试日志 ------------------------------- */

  /**
   * 发一条调试日志。关闭时 background 直接忽略，content 不需要读设置；
   * 发送失败（页面正在卸载等）也绝不能影响翻译。
   * @param {'info' | 'warn' | 'error'} level
   * @param {string} event
   * @param {string} [message]
   * @param {Record<string, unknown>} [data]
   * @param {{ source?: string, primary?: string }} [sample]
   */
  function logEvent(level, event, message, data, sample) {
    try {
      void chrome.runtime.sendMessage({
        type: 'debug.log',
        level,
        event,
        source: 'content',
        ...(message ? { message } : {}),
        data: {
          mode: state.mode,
          scope: state.scope,
          target: state.targetCode,
          ...(data || {}),
        },
        ...(state.debugSamples && sample ? { sample } : {}),
      });
    } catch {
      /* 日志失败不影响翻译 */
    }
  }

  /* ------------------------------- 后台调用 ------------------------------- */

  /**
   * @param {string[]} texts
   * @returns {Promise<{ translations: string[], protected: number, warnings: { index: number, missing: string[] }[], reviewCandidates: import('../types').ReviewCandidate[], reviewSkipped?: string }>}
   */
  async function requestTranslate(texts) {
    const res = await chrome.runtime.sendMessage({
      type: 'translate',
      texts,
      pageToken: state.pageToken,
    });
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
      reviewCandidates: Array.isArray(res.reviewCandidates) ? res.reviewCandidates : [],
      reviewSkipped: typeof res.reviewSkipped === 'string' ? res.reviewSkipped : undefined,
    };
  }

  /* ------------------------------- 并发调度 ------------------------------- */

  /**
   * 端点限流特性不同，批大小与并发不能一刀切：
   * - DeepL 单请求最多 50 条 text，但吞吐高，可以 4 路；
   * - OpenCode Go 限的是持续速率，少而大的批次更稳（实测 50 段 × 4 路会熔断）；
   * - 商汤 RPM 很低，1 路；
   * - 微软 MT 单请求有字符/条数上限，保守取 5,000 字符 / 100 段 / 4 路。
   * @returns {Promise<Policy>}
   */
  async function readPolicy() {
    if (state.policy) return state.policy;
    /** @type {Policy} */
    let policy;
    try {
      const status = await chrome.runtime.sendMessage({ type: 'status' });
      const active = status?.active;
      if (active?.protocol === 'google-free') {
        // 非官方接口一次只能一个 q：小批 + 串行，别一次打太多
        policy = { chars: 1500, items: 10, concurrency: 1 };
      } else if (active?.protocol === 'chrome-builtin') {
        // 端侧 Translator API 顺序处理；小批 + 单路，避免一次塞太多文本
        policy = { chars: 2000, items: 20, concurrency: 1 };
      } else if (active?.protocol === 'google-pa') {
        // Google 2 支持批量 POST；保守 3000 字符 / 50 段 / 2 路
        policy = { chars: 3000, items: 50, concurrency: 2 };
      } else if (active?.protocol === 'nvidia-riva') {
        // Riva 是专用翻译模型：协议内部一段一请求，外面用 2 路并发即可
        policy = { chars: 3000, items: 10, concurrency: 2 };
      } else if (active?.protocol === 'deepl') {
        policy = { chars: 3000, items: 50, concurrency: 4 };
      } else if (active?.protocol === 'microsoft-edge' || active?.protocol === 'microsoft-azure') {
        policy = { chars: 5000, items: 100, concurrency: 4 };
      } else if (active?.presetId === 'sensenova') {
        policy = { chars: 6000, items: 300, concurrency: 1 };
      } else {
        policy = { chars: 8000, items: 400, concurrency: 8 };
      }
    } catch {
      policy = { chars: BATCH_CHARS, items: BATCH_ITEMS, concurrency: 4 };
    }
    state.policy = policy;
    return policy;
  }

  /**
   * 视口 pass 用更小的批次，让第一批译文尽快出现；并发数保持不变。
   * @param {Policy} policy
   * @returns {Policy}
   */
  function viewportPolicy(policy) {
    return {
      chars: Math.min(policy.chars, VIEWPORT_BATCH_CHARS),
      items: Math.min(policy.items, VIEWPORT_BATCH_ITEMS),
      concurrency: policy.concurrency,
    };
  }

  /**
   * 有限并发执行批次；顺序由调用方按 index 写回，不依赖完成顺序。
   * - 第 0 批失败立即中止（多半是配置问题）
   * - 连续 3 批失败熔断，已完成的批次保留
   * - 返回失败批的下标，调用方可以串行补跑一趟
   * @template T
   * @param {T[]} jobs
   * @param {(job: T, index: number) => Promise<void>} worker
   * @param {number} concurrency
   * @param {{ abortOnFirst?: boolean }} [options]
   * @returns {Promise<{ stopped: boolean, failed: number[], unrun: number[] }>}
   */
  async function runPool(jobs, worker, concurrency, { abortOnFirst = true } = {}) {
    let next = 0;
    let consecutiveFailures = 0;
    let stopped = false;
    /** @type {unknown} */
    let firstError = null;
    /** @type {number[]} */
    const failed = [];
    const attempted = new Set();

    async function lane() {
      for (;;) {
        if (stopped) return;
        const index = next;
        next += 1;
        if (index >= jobs.length) return;
        attempted.add(index);
        try {
          await worker(jobs[index], index);
          consecutiveFailures = 0;
        } catch (err) {
          failed.push(index);
          consecutiveFailures += 1;
          if (abortOnFirst && index === 0) {
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
    /** @type {number[]} */
    const unrun = [];
    for (let index = 0; index < jobs.length; index += 1) {
      if (!attempted.has(index)) unrun.push(index);
    }
    return { stopped, failed: failed.sort((a, b) => a - b), unrun };
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
   * @returns {Block[]}
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
    /** @type {Block[]} */
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
   * @param {Block[]} blocks
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

  /* ------------------------------ 视口判定 ------------------------------ */

  /**
   * 元素是否与视口（含上下余量）相交。
   * rect 全 0 视为未布局 / 隐藏；没有布局能力的测试环境按可见处理。
   * @param {Element} el
   * @param {number} [margin]
   * @returns {boolean}
   */
  function inViewport(el, margin = VIEWPORT_MARGIN) {
    const rect = typeof el?.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    if (!rect) return true;
    const allZero =
      !rect.top && !rect.bottom && !rect.left && !rect.right && !rect.width && !rect.height;
    if (allZero) return false;

    const height = win.innerHeight || document.documentElement?.clientHeight || 0;
    if (!height) return true;
    const width = win.innerWidth || document.documentElement?.clientWidth || 0;

    if (rect.bottom < -margin || rect.top > height + margin) return false;
    if (width > 0 && (rect.right < -margin || rect.left > width + margin)) return false;
    return true;
  }

  /**
   * 纯译文按父元素判定：同一父元素的多个文本节点共享一次 rect。
   * @param {Text[]} nodes
   * @returns {{ visible: Text[], hidden: Text[] }}
   */
  function splitNodesByVisibility(nodes) {
    /** @type {Map<Element, boolean>} */
    const cache = new Map();
    /** @type {Text[]} */
    const visible = [];
    /** @type {Text[]} */
    const hidden = [];

    for (const node of nodes) {
      if (node.isConnected === false) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      let ok = cache.get(parent);
      if (ok === undefined) {
        ok = inViewport(parent);
        cache.set(parent, ok);
      }
      (ok ? visible : hidden).push(node);
    }
    return { visible, hidden };
  }

  /**
   * @param {Block[]} blocks
   * @returns {{ visible: Block[], hidden: Block[] }}
   */
  function splitBlocksByVisibility(blocks) {
    /** @type {Block[]} */
    const visible = [];
    /** @type {Block[]} */
    const hidden = [];
    for (const block of blocks) {
      if (block.el.isConnected === false) continue;
      (inViewport(block.el) ? visible : hidden).push(block);
    }
    return { visible, hidden };
  }

  /* ------------------------------- 写回 / 插入 ------------------------------- */

  /**
   * 成功拿到译文的节点都记入 seen：术语回退成原文也不会在滚动时反复重发。
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
      state.seenNodes.add(node);
      if (next.trim() === from.trim()) return;
      node.nodeValue = from.replace(from.trim(), next.trim());
      state.originals.push({ node, text: from });
      count += 1;
    });
    return count;
  }

  /**
   * 译文追加到块内末尾（`append`，不是兄弟 `div`），表格 / 列表结构安全。
   * @param {Block[]} blocks
   * @param {{ blockIndex: number, chunkIndex: number }[]} segments
   * @param {string[]} translations
   * @returns {{ inserted: number, remaining: Block[] }}
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
    /** @type {Block[]} */
    const remaining = [];

    blocks.forEach((block, blockIndex) => {
      const parts = byBlock.get(blockIndex);
      if (!parts || parts.length === 0) return;
      // 有 chunk 没翻出来就整块跳过，不要把半截译文拼上去；留到下次滚动重试
      if (parts.some((part) => typeof part !== 'string' || !part.trim())) {
        if (block.el.isConnected !== false) remaining.push(block);
        return;
      }

      // 请求成功：即使译文等于原文（术语回退）也算处理过，避免无限重试
      state.seenBlocks.add(block.el);

      const text = joinChunks(parts).trim();
      if (!text) return;

      // 记下分片与原文：迟到的审校修正要重算 join，撤销也要换回主译文
      const chunks = parts.map((part) => String(part ?? '').trim());
      state.blockTranslations.set(block.el, chunks);
      state.blockSources.set(block.el, block.text);

      // 术语回退时译文可能等于原文：不要再复制一份（修正后仍可插入）
      if (text === block.text.trim()) return;

      const span = document.createElement('span');
      span.className = 'sopen-translated-block';
      span.setAttribute('data-sopen-translated', '');
      span.style.display = 'block';
      span.textContent = text;

      if (typeof block.el.append === 'function') block.el.append(span);
      else block.el.appendChild(span);

      state.injected.push(span);
      state.blockSpans.set(block.el, span);
      inserted += 1;
    });
    return { inserted, remaining };
  }

  /* ------------------------------- 还原 / 观察器 ------------------------------- */

  function disconnectObservers() {
    for (const cleanup of state.cleanups) {
      try {
        cleanup();
      } catch {
        /* 宿主页面卸载时忽略 */
      }
    }
    state.cleanups = [];
  }

  function resetPage() {
    disconnectObservers();
    clearTimeout(state.scanTimer);
    state.scanTimer = 0;
    clearTimeout(state.reviewTimer);
    state.reviewTimer = 0;
    // 代次递增：晚到的 review 响应看到 generation 不一致就直接丢弃
    state.generation += 1;

    for (const el of state.injected) {
      if (typeof el.remove === 'function') el.remove();
      else el.parentElement?.removeChild?.(el);
    }
    state.injected = [];
    for (const { node, text } of state.originals) node.nodeValue = text;
    state.originals = [];

    state.seenNodes = new WeakSet();
    state.seenBlocks = new WeakSet();
    state.queuedNodes = new WeakSet();
    state.queuedBlocks = new WeakSet();
    state.pendingNodes = [];
    state.pendingBlocks = [];
    state.pending = false;
    state.paused = false;
    state.pendingScan = false;
    state.policy = null;
    state.pageToken = '';
    state.target = '';
    state.targetCode = '';
    state.progress = { done: 0, total: 0 };

    state.reviewTargets = new Map();
    state.textIds = new WeakMap();
    state.blockIds = new WeakMap();
    state.blockTranslations = new Map();
    state.blockSpans = new Map();
    state.blockSources = new Map();
    state.idSeq = 0;
    state.reviewQueue = [];
    state.reviewInFlight = false;
    state.reviewAttempts = 0;
    state.reviewLog = [];
    state.review = { pending: false, reviewed: 0, corrected: 0, failed: false, truncated: false };
  }

  function restorePage() {
    if (state.busy) return { ok: false, error: '正在翻译中，等这一轮结束再还原' };
    const count = state.injected.length + state.originals.length;
    logEvent('info', 'page.restore', undefined, { count });
    resetPage();
    hideToast();
    return { ok: true, restored: count };
  }

  /* ------------------------------- 设置 ------------------------------- */

  /**
   * 模式、范围、目标语言同一次读取，避免几套逻辑读到不同代的设置。
   * @returns {Promise<{ mode: 'translation' | 'bilingual', scope: 'viewport' | 'whole', target: string, targetCode: string, samples: boolean }>}
   */
  async function readPageSettings() {
    try {
      const data = /** @type {{ settings?: { displayMode?: string, translateScope?: string, targetLang?: string, targetLangCode?: string, debugLogSamples?: boolean } }} */ (
        await chrome.storage.local.get('settings')
      );
      const settings = data.settings || {};
      return {
        mode: settings.displayMode === 'bilingual' ? 'bilingual' : 'translation',
        scope: settings.translateScope === 'whole' ? 'whole' : 'viewport',
        target: typeof settings.targetLang === 'string' ? settings.targetLang : '',
        targetCode: typeof settings.targetLangCode === 'string' ? settings.targetLangCode : '',
        samples: settings.debugLogSamples === true,
      };
    } catch {
      return { mode: 'translation', scope: 'viewport', target: '', targetCode: '', samples: false };
    }
  }

  /* ------------------------------- 进度文案 ------------------------------- */

  /**
   * @param {boolean} [scrolling]
   * @returns {string}
   */
  function progressText(scrolling = false) {
    const mode = state.mode === 'bilingual' ? '双语' : '';
    const scope = scrolling ? (mode ? `${mode}·滚动` : '滚动') : mode;
    const label = scope ? `翻译中（${scope}）` : '翻译中';
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

  /* ------------------------------- 异步审校 ------------------------------- */

  /** @param {Text} node @returns {string} */
  function textId(node) {
    let id = state.textIds.get(node);
    if (!id) {
      state.idSeq += 1;
      id = `n${state.idSeq}`;
      state.textIds.set(node, id);
    }
    return id;
  }

  /** @param {Element} el @returns {string} */
  function blockId(el) {
    let id = state.blockIds.get(el);
    if (!id) {
      state.idSeq += 1;
      id = `b${state.idSeq}`;
      state.blockIds.set(el, id);
    }
    return id;
  }

  /**
   * 把一批可疑段转成送审项：candidates 的 index 是**本批**下标，
   * resolve 负责把它映射到稳定 id 与原文/主译文。
   * @param {import('../types').ReviewCandidate[]} candidates
   * @param {(index: number) => (import('../types').ReviewRunItem | null)} resolve
   */
  function enqueueReviewCandidates(candidates, resolve) {
    if (candidates.length === 0) return;
    for (const candidate of candidates) {
      if (!candidate || !Number.isInteger(candidate.index)) continue;
      const item = resolve(candidate.index);
      if (!item) continue;
      item.reasons = Array.isArray(candidate.reasons) ? candidate.reasons : [];
      item.missing = Array.isArray(candidate.missing) ? candidate.missing : [];
      state.reviewQueue.push(item);
    }
    if (state.reviewQueue.length === 0) return;
    state.review.pending = true;
    scheduleReview(REVIEW_DEBOUNCE_MS);
  }

  /** @param {number} delay */
  function scheduleReview(delay) {
    if (state.reviewTimer || state.reviewInFlight) return;
    state.reviewTimer = setTimeout(() => {
      state.reviewTimer = 0;
      void flushReview();
    }, delay);
  }

  /** 页面上下文：只带标题与 URL，域名/类型由 background 推导 */
  function pageContext() {
    return {
      title: typeof document.title === 'string' ? document.title : '',
      url: typeof location !== 'undefined' && location.href ? location.href : '',
    };
  }

  /**
   * 同一时间只允许一个 review.run 在飞；多个批次用防抖合并。
   * 响应回来先比对 generation，晚到的一律丢弃。
   */
  async function flushReview() {
    if (state.reviewInFlight || state.reviewQueue.length === 0) return;
    if (!state.pageToken) return;

    state.reviewInFlight = true;
    const generation = state.generation;
    const batch = state.reviewQueue.splice(0, REVIEW_QUEUE_MAX);
    logEvent(
      'info',
      'review.start',
      undefined,
      {
        items: batch.length,
        chars: batch.reduce((sum, item) => sum + item.source.length + item.primary.length, 0),
      },
      { source: batch[0]?.source, primary: batch[0]?.primary },
    );

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'review.run',
        pageToken: state.pageToken,
        target: state.target,
        targetCode: state.targetCode,
        context: pageContext(),
        items: batch.map((item) => ({
          id: item.id,
          source: item.source,
          primary: item.primary,
          reasons: item.reasons,
          missing: item.missing,
          ...(item.prev ? { prev: item.prev } : {}),
          ...(item.next ? { next: item.next } : {}),
        })),
      });
      // 还原 / 重新翻译后，旧响应不能再写回 DOM
      if (generation !== state.generation) return;
      if (!res) throw new Error('扩展后台没有响应');
      if (!res.ok) throw new Error(res.error || '审校失败');

      if (res.review?.failed) state.review.failed = true;
      if (res.review?.truncated) state.review.truncated = true;
      state.review.reviewed += Number(res.review?.reviewed) || batch.length;
      applyCorrections(batch, res);
      state.reviewAttempts = 0;
      logEvent(
        res.review?.failed ? 'warn' : 'info',
        res.review?.failed ? 'review.failed' : 'review.end',
        res.review?.failed ? '审校失败，保留主译文' : undefined,
        {
          reviewed: Number(res.review?.reviewed) || batch.length,
          corrected: Number(res.review?.corrected) || 0,
          rejected: Array.isArray(res.rejected) ? res.rejected.length : 0,
          truncated: Boolean(res.review?.truncated),
        },
      );
    } catch (err) {
      if (generation !== state.generation) return;
      logEvent('warn', 'review.failed', errorText(err), { attempt: state.reviewAttempts + 1 });
      if (state.reviewAttempts < 1) {
        // 只退避重试一次；仍失败就保留主译文结束本次审校
        state.reviewAttempts += 1;
        state.reviewQueue.unshift(...batch);
        state.review.pending = true;
        scheduleReview(REVIEW_RETRY_MS);
        return;
      }
      state.review.failed = true;
      state.reviewAttempts = 0;
      console.warn('[sopen-translate] 审校失败，保留主译文', err);
    } finally {
      if (generation === state.generation) {
        state.reviewInFlight = false;
        // 预算已满：后面的候选不再逐批发无用请求
        if (state.review.truncated) state.reviewQueue = [];
        state.review.pending = state.reviewQueue.length > 0;
        if (state.reviewQueue.length > 0) scheduleReview(REVIEW_RETRY_MS);
      }
    }
  }

  /**
   * @param {import('../types').ReviewRunItem[]} batch
   * @param {any} res
   */
  function applyCorrections(batch, res) {
    /** @type {Map<string, string>} */
    const corrections = new Map();
    for (const entry of Array.isArray(res?.corrections) ? res.corrections : []) {
      const id = String(entry?.id ?? '');
      const corrected = String(entry?.corrected ?? '');
      if (id && corrected.trim()) corrections.set(id, corrected.trim());
    }
    /** @type {Map<string, string>} */
    const rejected = new Map();
    for (const entry of Array.isArray(res?.rejected) ? res.rejected : []) {
      const id = String(entry?.id ?? '');
      const reason = String(entry?.reason ?? '');
      if (id && reason) rejected.set(id, reason);
    }

    for (const item of batch) {
      const corrected = corrections.get(item.id) ?? null;
      /** @type {string | null} */
      let rejectedReason = null;
      let applied = false;
      if (corrected) {
        applied = patchSegment(item.id, corrected);
        if (!applied) rejectedReason = 'detached';
      } else {
        rejectedReason = rejected.get(item.id) || 'unchanged';
      }
      if (applied) state.review.corrected += 1;

      state.reviewLog.push({
        id: item.id,
        source: item.source,
        primary: item.primary,
        corrected,
        reasons: item.reasons,
        applied,
        rejectedReason,
      });
      if (state.reviewLog.length > REVIEW_LOG_MAX) state.reviewLog.shift();
    }
  }

  /**
   * 按 id 找 DOM 目标并打补丁。节点断开 / SPA 重渲染时返回 false，不报错。
   * @param {string} id
   * @param {string} corrected
   * @returns {boolean}
   */
  function patchSegment(id, corrected) {
    const target = state.reviewTargets.get(id);
    if (!target) return false;

    if (target.kind === 'text') {
      const node = target.node;
      if (node.isConnected === false) return false;
      const current = node.nodeValue || '';
      if (!current.trim()) return false;
      if (corrected.trim() === current.trim()) return false;
      node.nodeValue = current.replace(current.trim(), corrected.trim());
      target.appliedFull = node.nodeValue;
      return true;
    }

    const chunks = state.blockTranslations.get(target.el);
    if (!chunks) return false;
    // 只要还有空分片就说明整块译文不完整，不能把半截译文插进页面
    if (chunks.some((chunk) => !String(chunk ?? '').trim())) return false;
    chunks[target.chunkIndex] = corrected;
    const text = joinChunks(chunks).trim();
    if (!text) return false;

    let span = state.blockSpans.get(target.el);
    if (!span || span.isConnected === false) {
      if (target.el.isConnected === false) return false;
      // 原本因“译文=原文”没插入的块，修正后可以插入了
      if (text === (state.blockSources.get(target.el) || '').trim()) return false;
      span = document.createElement('span');
      span.className = 'sopen-translated-block';
      span.setAttribute('data-sopen-translated', '');
      span.style.display = 'block';
      span.textContent = text;
      if (typeof target.el.append === 'function') target.el.append(span);
      else target.el.appendChild(span);
      state.injected.push(span);
      state.blockSpans.set(target.el, span);
      return true;
    }

    span.textContent = text;
    return true;
  }

  /** @returns {{ reviewed: number, corrected: number, rejected: number, failed: boolean, truncated: boolean, pending: boolean }} */
  function reviewSummary() {
    return {
      reviewed: state.review.reviewed,
      corrected: state.review.corrected,
      rejected: Math.max(0, state.review.reviewed - state.review.corrected),
      failed: state.review.failed,
      truncated: state.review.truncated,
      pending: state.review.pending,
    };
  }

  /**
   * 撤销本次审校：只把 applied 的条目换回主译文，不影响还原语义。
   * @returns {{ ok: boolean, undone: number }}
   */
  function undoReview() {
    let undone = 0;
    for (const entry of state.reviewLog) {
      if (!entry.applied) continue;
      const target = state.reviewTargets.get(entry.id);
      if (!target) continue;

      if (target.kind === 'text') {
        const node = target.node;
        if (node.isConnected === false) continue;
        if (target.appliedFull !== null && node.nodeValue !== target.appliedFull) continue;
        node.nodeValue = target.primaryFull;
        target.appliedFull = null;
        entry.applied = false;
        undone += 1;
        continue;
      }

      const chunks = state.blockTranslations.get(target.el);
      if (!chunks) continue;
      chunks[target.chunkIndex] = entry.primary;
      const text = joinChunks(chunks).trim();
      const span = state.blockSpans.get(target.el);
      if (span && span.isConnected !== false) {
        // 主译文本身等于原文：撤销后不应留下重复的译文块
        if (text === (state.blockSources.get(target.el) || '').trim()) {
          if (typeof span.remove === 'function') span.remove();
          else span.parentElement?.removeChild?.(span);
          state.blockSpans.delete(target.el);
        } else {
          span.textContent = text;
        }
      }
      entry.applied = false;
      undone += 1;
    }
    state.review.corrected = Math.max(0, state.review.corrected - undone);
    return { ok: true, undone };
  }

  /* ------------------------------- 纯译文 ------------------------------- */

  /**
   * @param {Text[]} nodes
   * @param {{ scrolling?: boolean, policy?: Policy }} [options]
   * @returns {Promise<{ translated: number, failed: number, protected: number, warnings: number, stopped: boolean, remaining: Text[] }>}
   */
  async function runTextPass(nodes, { scrolling = false, policy: policyOverride } = {}) {
    if (nodes.length === 0) {
      return { translated: 0, failed: 0, protected: 0, warnings: 0, stopped: false, remaining: [] };
    }

    state.progress.total += nodes.length;
    const policy = policyOverride || (await readPolicy());
    const batches = batchNodes(nodes, policy);
    let translated = 0;
    let protectedCount = 0;
    let warnings = 0;

    /** @param {Text[]} batch */
    const worker = async (batch) => {
      showToast(progressText(scrolling));
      const texts = batch.map((node) => (node.nodeValue || '').trim());
      try {
        const result = await requestTranslate(texts);
        protectedCount += result.protected;
        warnings += result.warnings.length;
        translated += applyTextTranslations(batch, result.translations);
        enqueueReviewCandidates(result.reviewCandidates, (index) => {
          const node = batch[index];
          if (!node || node.isConnected === false) return null;
          const id = textId(node);
          state.reviewTargets.set(id, {
            kind: 'text',
            node,
            primaryFull: node.nodeValue || '',
            appliedFull: null,
          });
          return {
            id,
            source: texts[index],
            primary: String(result.translations[index] ?? '').trim(),
            reasons: [],
            missing: [],
            ...(index > 0 ? { prev: texts[index - 1] } : {}),
            ...(index + 1 < texts.length ? { next: texts[index + 1] } : {}),
          };
        });
      } catch (err) {
        logEvent(
          'warn',
          'batch.fail',
          errorText(err),
          { items: batch.length, chars: texts.reduce((sum, text) => sum + text.length, 0) },
          { source: texts[0] },
        );
        throw err;
      } finally {
        state.progress.done = Math.min(
          state.progress.total,
          state.progress.done + batch.length,
        );
      }
    };

    // 第 0 批失败会在这里抛错，交给上层中止
    const first = await runPool(batches, worker, policy.concurrency);
    let stillFailed = first.failed;
    if (!first.stopped && stillFailed.length > 0) {
      // 第二趟补跑：高并发下的 429 往往是瞬时的，冷却后能补回来
      logEvent('info', 'batch.retry', undefined, { batches: stillFailed.length });
      const retry = await runPool(
        stillFailed.map((index) => batches[index]),
        worker,
        RETRY_CONCURRENCY,
        { abortOnFirst: false },
      );
      stillFailed = [...retry.failed, ...retry.unrun].map((index) => stillFailed[index]);
    }

    const remainingBatches = stillFailed.map((index) => batches[index]);
    const failed = remainingBatches.reduce((sum, batch) => sum + batch.length, 0);
    /** @type {Text[]} */
    const remaining = [];
    for (const batch of remainingBatches) {
      for (const node of batch) {
        if (node.isConnected === false) continue;
        if (!state.seenNodes.has(node)) remaining.push(node);
      }
    }

    return {
      translated,
      failed,
      protected: protectedCount,
      warnings,
      stopped: first.stopped,
      remaining,
    };
  }

  /* ------------------------------- 双语 ------------------------------- */

  /**
   * @param {Block[]} blocks
   * @param {{ scrolling?: boolean, policy?: Policy }} [options]
   * @returns {Promise<{ translated: number, failed: number, protected: number, warnings: number, stopped: boolean, remaining: Block[] }>}
   */
  async function runBlockPass(blocks, { scrolling = false, policy: policyOverride } = {}) {
    if (blocks.length === 0) {
      return { translated: 0, failed: 0, protected: 0, warnings: 0, stopped: false, remaining: [] };
    }

    const segments = buildSegments(blocks);
    state.progress.total += segments.length;
    const policy = policyOverride || (await readPolicy());
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
    let protectedCount = 0;
    let warnings = 0;

    /** @param {{ items: { text: string }[], offset: number }} job */
    const worker = async (job) => {
      showToast(progressText(scrolling));
      try {
        const result = await requestTranslate(job.items.map((segment) => segment.text));
        result.translations.forEach((text, position) => {
          translations[job.offset + position] = text;
        });
        protectedCount += result.protected;
        warnings += result.warnings.length;
        enqueueReviewCandidates(result.reviewCandidates, (index) => {
          const globalIndex = job.offset + index;
          const segment = segments[globalIndex];
          if (!segment) return null;
          const block = blocks[segment.blockIndex];
          if (!block || block.el.isConnected === false) return null;
          const id = `${blockId(block.el)}:${segment.chunkIndex}`;
          state.reviewTargets.set(id, {
            kind: 'block',
            el: block.el,
            chunkIndex: segment.chunkIndex,
          });
          const prev = globalIndex > 0 ? segments[globalIndex - 1]?.text : undefined;
          const next = globalIndex + 1 < segments.length ? segments[globalIndex + 1]?.text : undefined;
          return {
            id,
            source: segment.text,
            primary: String(result.translations[index] ?? '').trim(),
            reasons: [],
            missing: [],
            ...(prev ? { prev } : {}),
            ...(next ? { next } : {}),
          };
        });
      } catch (err) {
        logEvent(
          'warn',
          'batch.fail',
          errorText(err),
          { items: job.items.length, chars: job.items.reduce((sum, item) => sum + item.text.length, 0) },
          { source: job.items[0]?.text },
        );
        throw err;
      } finally {
        state.progress.done = Math.min(
          state.progress.total,
          state.progress.done + job.items.length,
        );
      }
    };

    const first = await runPool(jobs, worker, policy.concurrency);
    let stillFailed = first.failed;
    if (!first.stopped && stillFailed.length > 0) {
      logEvent('info', 'batch.retry', undefined, { batches: stillFailed.length });
      const retry = await runPool(
        stillFailed.map((index) => jobs[index]),
        worker,
        RETRY_CONCURRENCY,
        { abortOnFirst: false },
      );
      stillFailed = [...retry.failed, ...retry.unrun].map((index) => stillFailed[index]);
    }
    const failed = stillFailed.reduce((sum, index) => sum + jobs[index].items.length, 0);

    const applied = applyBlockTranslations(blocks, segments, translations);
    return {
      translated: applied.inserted,
      failed,
      protected: protectedCount,
      warnings,
      stopped: first.stopped,
      remaining: applied.remaining,
    };
  }

  /* ------------------------------- 补翻调度 ------------------------------- */

  /**
   * @param {() => void} fn
   * @param {number} wait
   * @returns {() => void}
   */
  function throttle(fn, wait) {
    let last = 0;
    let timer = 0;
    return () => {
      const now = Date.now();
      const remaining = wait - (now - last);
      if (remaining <= 0) {
        last = now;
        fn();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        last = Date.now();
        fn();
      }, remaining);
    };
  }

  /** 把 MutationObserver 看到的新内容补进 pending（去重） */
  function enqueueNewCandidates() {
    if (state.mode === 'bilingual') {
      for (const block of collectBlocks()) {
        if (state.seenBlocks.has(block.el) || state.queuedBlocks.has(block.el)) continue;
        state.queuedBlocks.add(block.el);
        state.pendingBlocks.push(block);
      }
      return;
    }

    for (const node of collectTextNodes()) {
      if (state.seenNodes.has(node) || state.queuedNodes.has(node)) continue;
      state.queuedNodes.add(node);
      state.pendingNodes.push(node);
    }
  }

  /** 自己插入的译文块 / 浮层不算“页面变了”，否则每次写入都会触发一次重扫 */
  function isOwnNode(node) {
    if (!node) return true;
    if (node.nodeType === 1) {
      const el = /** @type {Element} */ (node);
      if (el.id === 'sopen-translate-ui') return true;
      if (el.classList?.contains?.('sopen-translated-block')) return true;
      if (el.hasAttribute?.('data-sopen-translated')) return true;
      return false;
    }
    if (node.nodeType === 3) {
      const parent = /** @type {Text} */ (node).parentElement;
      return Boolean(parent?.closest?.('.sopen-translated-block'));
    }
    return false;
  }

  function installObservers() {
    if (state.scope !== 'viewport' || state.cleanups.length > 0) return;

    const onScroll = throttle(() => scheduleScan(), SCROLL_THROTTLE_MS);
    win.addEventListener('scroll', onScroll, { passive: true });
    win.addEventListener('resize', onScroll, { passive: true });
    state.cleanups.push(() => {
      win.removeEventListener('scroll', onScroll);
      win.removeEventListener('resize', onScroll);
    });

    if (typeof document.addEventListener === 'function') {
      const onVisibility = () => {
        state.paused = document.hidden === true;
        if (state.paused) return;
        // 回到前台补扫一次：隐藏期间可能已经滚到新位置
        enqueueNewCandidates();
        scheduleScan();
      };
      document.addEventListener('visibilitychange', onVisibility);
      state.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }

    if (typeof MutationObserver === 'function' && document.body) {
      let timer = 0;
      const observer = new MutationObserver((records) => {
        const meaningful = records.some(
          (record) =>
            record.removedNodes.length > 0 ||
            Array.from(record.addedNodes || []).some((node) => !isOwnNode(node)),
        );
        if (!meaningful) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          timer = 0;
          enqueueNewCandidates();
          scheduleScan();
        }, MUTATION_DEBOUNCE_MS);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      state.cleanups.push(() => {
        clearTimeout(timer);
        observer.disconnect();
      });
    }
  }

  /** 是否还有“现在就看得见”的未处理候选 */
  function hasVisiblePending() {
    if (state.scope !== 'viewport') return false;
    if (state.mode === 'bilingual') {
      return splitBlocksByVisibility(state.pendingBlocks).visible.length > 0;
    }
    return splitNodesByVisibility(state.pendingNodes).visible.length > 0;
  }

  /** 当前没有任务在跑时才排期；任务中来的滚动请求合并到这一轮之后 */
  function scheduleScan() {
    if (state.scope !== 'viewport' || state.paused) return;
    if (state.busy) {
      state.pendingScan = true;
      return;
    }
    if (state.scanTimer) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = 0;
      void scanVisible();
    }, 0);
  }

  /** 只翻“现在可见”的 pending，剩下的留到下次滚动 */
  async function scanVisible() {
    if (state.busy || state.scope !== 'viewport' || state.paused) return null;
    if (state.mode === 'bilingual' ? state.pendingBlocks.length === 0 : state.pendingNodes.length === 0) {
      state.pending = false;
      return null;
    }
    logEvent('info', 'scroll.scan', undefined, {
      pending:
        state.mode === 'bilingual' ? state.pendingBlocks.length : state.pendingNodes.length,
    });

    // 请求失败（含第 0 批中止）时这些可见候选还没被标记，必须放回 pending，
    // 否则它们既不在 pending 也不在 seen，会永远漏翻。
    /** @type {Block[]} */
    let retryBlocks = [];
    /** @type {Text[]} */
    let retryNodes = [];

    state.busy = true;
    try {
      const policy = viewportPolicy(await readPolicy());
      if (state.mode === 'bilingual') {
        const split = splitBlocksByVisibility(state.pendingBlocks);
        state.pendingBlocks = split.hidden;
        retryBlocks = split.visible;
        const outcome = await runBlockPass(split.visible, { scrolling: true, policy });
        retryBlocks = [];
        state.pendingBlocks.push(...outcome.remaining);
        state.pending = hasVisiblePending();
        if (outcome.translated > 0) {
          showToast(
            summaryText(`已翻译可视区域 ${translatedCount()} 块，滚动继续翻译`, outcome),
            { timeout: 2500 },
          );
        }
        return outcome;
      }

      const split = splitNodesByVisibility(state.pendingNodes);
      state.pendingNodes = split.hidden;
      retryNodes = split.visible;
      const outcome = await runTextPass(split.visible, { scrolling: true, policy });
      retryNodes = [];
      state.pendingNodes.push(...outcome.remaining);
      state.pending = hasVisiblePending();
      if (outcome.translated > 0) {
        showToast(
          summaryText(`已翻译可视区域 ${translatedCount()} 段，滚动继续翻译`, outcome),
          { timeout: 2500 },
        );
      }
      return outcome;
    } catch (err) {
      // 补翻失败不打扰用户：失败项放回 pending，下次滚动会再试
      logEvent('error', 'error', errorText(err), { where: 'scanVisible' });
      for (const block of retryBlocks) {
        if (state.seenBlocks.has(block.el) || state.queuedBlocks.has(block.el)) continue;
        state.queuedBlocks.add(block.el);
        state.pendingBlocks.push(block);
      }
      for (const node of retryNodes) {
        if (state.seenNodes.has(node) || state.queuedNodes.has(node)) continue;
        state.queuedNodes.add(node);
        state.pendingNodes.push(node);
      }
      state.pending = hasVisiblePending();
      return null;
    } finally {
      state.busy = false;
      if (state.pendingScan) {
        state.pendingScan = false;
        scheduleScan();
      }
    }
  }

  /* ------------------------------- 整页翻译 ------------------------------- */

  async function translateWhole() {
    if (state.mode === 'bilingual') {
      const blocks = collectBlocks();
      if (blocks.length === 0) {
        showToast('这一页没找到可翻译的文本', { timeout: 2500 });
        return { ok: false, error: '没有可翻译的文本' };
      }
      const outcome = await runBlockPass(blocks);
      showToast(
        summaryText(`已翻译 ${outcome.translated} 块`, outcome),
        { timeout: 3000 },
      );
      return { ok: true, ...outcome };
    }

    const nodes = collectTextNodes();
    if (nodes.length === 0) {
      showToast('这一页没找到可翻译的文本', { timeout: 2500 });
      return { ok: false, error: '没有可翻译的文本' };
    }
    const outcome = await runTextPass(nodes);
    showToast(
      summaryText(`已翻译 ${outcome.translated} 段`, outcome),
      { timeout: 3000 },
    );
    return { ok: true, ...outcome };
  }

  async function translateViewportFirst() {
    const policy = viewportPolicy(await readPolicy());
    if (state.mode === 'bilingual') {
      const blocks = collectBlocks();
      if (blocks.length === 0) {
        showToast('这一页没找到可翻译的文本', { timeout: 2500 });
        return { ok: false, error: '没有可翻译的文本' };
      }
      const split = splitBlocksByVisibility(blocks);
      state.pendingBlocks = split.hidden;
      for (const block of split.hidden) state.queuedBlocks.add(block.el);

      const outcome = await runBlockPass(split.visible, { policy });
      for (const block of outcome.remaining) {
        if (!state.queuedBlocks.has(block.el)) {
          state.queuedBlocks.add(block.el);
          state.pendingBlocks.push(block);
        }
      }
      state.pending = hasVisiblePending();
      showToast(
        summaryText(`已翻译可视区域 ${outcome.translated} 块，滚动继续翻译`, outcome),
        { timeout: 3000 },
      );
      return { ok: true, ...outcome };
    }

    const nodes = collectTextNodes();
    if (nodes.length === 0) {
      showToast('这一页没找到可翻译的文本', { timeout: 2500 });
      return { ok: false, error: '没有可翻译的文本' };
    }
    const split = splitNodesByVisibility(nodes);
    state.pendingNodes = split.hidden;
    for (const node of split.hidden) state.queuedNodes.add(node);

    const outcome = await runTextPass(split.visible, { policy });
    for (const node of outcome.remaining) {
      if (!state.queuedNodes.has(node)) {
        state.queuedNodes.add(node);
        state.pendingNodes.push(node);
      }
    }
    state.pending = hasVisiblePending();
    showToast(
      summaryText(`已翻译可视区域 ${outcome.translated} 段，滚动继续翻译`, outcome),
      { timeout: 3000 },
    );
    return { ok: true, ...outcome };
  }

  async function translatePage() {
    if (state.busy) return { ok: false, error: '正在翻译中' };

    // 先占住 busy：读设置是异步的，不先占住会让连点两次都通过检查
    state.busy = true;
    try {
      // 每轮都从原文出发：上一轮没还原就先还原，避免译文被二次翻译
      resetPage();
      // 审校预算按“这一轮页面翻译”累计，滚动续翻共用同一个 token
      state.pageToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const page = await readPageSettings();
      state.mode = page.mode;
      state.scope = page.scope;
      state.target = page.target;
      state.targetCode = page.targetCode;
      state.debugSamples = page.samples;
      logEvent('info', 'page.translate.start', undefined, {
        url: pageContext().url,
        scope: state.scope,
      });

      const result =
        state.scope === 'whole' ? await translateWhole() : await translateViewportFirst();
      if (result.ok && state.scope === 'viewport') installObservers();
      logEvent(result.ok ? 'info' : 'warn', 'page.translate.end', undefined, {
        translated: Number(/** @type {any} */ (result).translated) || 0,
        failed: Number(/** @type {any} */ (result).failed) || 0,
        stopped: Boolean(/** @type {any} */ (result).stopped),
        pending: state.pending,
      });
      return result;
    } catch (err) {
      showToast(`翻译失败：${errorText(err)}`, { error: true, timeout: 5000 });
      logEvent('error', 'error', errorText(err), { where: 'translatePage' });
      return { ok: false, error: errorText(err) };
    } finally {
      state.busy = false;
      // 首屏期间若有滚动请求，任务结束后补扫
      if (state.pendingScan) {
        state.pendingScan = false;
        scheduleScan();
      }
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
      case 'page.review':
        sendResponse({ ok: true, log: state.reviewLog.slice(), summary: reviewSummary() });
        return false;
      case 'page.review.undo':
        sendResponse(undoReview());
        return false;
      case 'page.status':
        sendResponse({
          ok: true,
          translated: translatedCount(),
          busy: state.busy,
          mode: state.mode,
          scope: state.scope,
          pending: state.pending,
          progress: state.progress,
          review: {
            pending: state.review.pending,
            reviewed: state.review.reviewed,
            corrected: state.review.corrected,
            failed: state.review.failed,
            truncated: state.review.truncated,
          },
        });
        return false;
      default:
        return false;
    }
  });
})();
