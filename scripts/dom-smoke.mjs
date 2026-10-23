/**
 * content script 冒烟测试：用一个最小假 DOM 直接加载 extension/content.js，
 * 验证纯译文 / 双语两条渲染路径、还原、熔断与进度。
 *
 * 跑法：npm run smoke:dom
 * 这不是 DOM 实现，只是够 content.js 跑起来的桩：
 * - TreeWalker 的过滤语义按「只遍历文本节点」实现；
 * - innerText 只按块级子元素加换行，不做真实布局；
 * - querySelector(All) 只支持 `.class` 与 tag，够 content.js 与用例用。
 */

import assert from 'node:assert/strict';

const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const SHOW_TEXT = 4;

/** innerText 里需要换行的块级标签（够用例用） */
const BLOCKY = new Set([
  'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'P', 'LI', 'UL', 'OL', 'TABLE', 'THEAD',
  'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'FIGURE', 'FORM', 'NAV', 'HEADER', 'FOOTER', 'ASIDE',
  'DL', 'DT', 'DD', 'BODY',
]);

/* ------------------------------- 假 DOM ------------------------------- */

/** 默认所有元素都“在视口里”；需要测视口优先时给元素设置 rect */
const VISIBLE_RECT = { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 };
const ZERO_RECT = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };

function makeText(value) {
  return { nodeType: 3, nodeValue: value, parentElement: null, parentNode: null };
}

function markConnected(node, value) {
  node.isConnected = value;
  if (node.nodeType === 1) for (const kid of node.children) markConnected(kid, value);
}

/** @param {string} selector @param {any} el */
function matches(el, selector) {
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  return el.tagName === selector.toUpperCase();
}

function makeElement(tagName) {
  /** @type {any} */
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    children: [],
    parentElement: null,
    parentNode: null,
    isContentEditable: false,
    isConnected: false,
    id: '',
    className: '',
    hidden: false,
    dataset: {},
    style: {},
    /** @type {{ top: number, left: number, right: number, bottom: number, width: number, height: number } | null} */
    rect: null,
    _text: '',
    _attrs: {},

    getBoundingClientRect() {
      if (node.rect) return node.rect;
      if (node.hidden) return ZERO_RECT;
      return VISIBLE_RECT;
    },

    append(...kids) {
      for (const kid of kids) {
        if (kid == null) continue;
        kid.parentElement = node;
        kid.parentNode = node;
        node.children.push(kid);
        markConnected(kid, node.isConnected);
      }
    },

    appendChild(kid) {
      node.append(kid);
    },

    remove() {
      const parent = node.parentElement;
      if (parent) {
        const index = parent.children.indexOf(node);
        if (index !== -1) parent.children.splice(index, 1);
      }
      node.parentElement = null;
      node.parentNode = null;
      markConnected(node, false);
    },

    setAttribute(name, value) {
      node._attrs[name] = String(value);
    },

    getAttribute(name) {
      return name in node._attrs ? node._attrs[name] : null;
    },

    hasAttribute(name) {
      return name in node._attrs;
    },

    closest(selector) {
      let current = node;
      while (current && current.nodeType === 1) {
        if (matches(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },

    querySelectorAll(selector) {
      /** @type {any[]} */
      const found = [];
      const walk = (current) => {
        for (const child of current.children) {
          if (child.nodeType !== 1) continue;
          if (matches(child, selector)) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    },

    querySelector(selector) {
      return node.querySelectorAll(selector)[0] || null;
    },

    addEventListener() {},
  };

  node.classList = {
    contains(name) {
      return String(node.className || '')
        .split(/\s+/)
        .filter(Boolean)
        .includes(name);
    },
    add(name) {
      if (node.classList.contains(name)) return;
      const current = String(node.className || '')
        .split(/\s+/)
        .filter(Boolean);
      current.push(name);
      node.className = current.join(' ');
    },
    remove(name) {
      node.className = String(node.className || '')
        .split(/\s+/)
        .filter((item) => item && item !== name)
        .join(' ');
    },
    toggle(name, force) {
      const has = node.classList.contains(name);
      const next = force === undefined ? !has : Boolean(force);
      if (next && !has) node.classList.add(name);
      if (!next && has) node.classList.remove(name);
      return next;
    },
  };

  Object.defineProperty(node, 'textContent', {
    get() {
      if (node.children.length === 0) return node._text;
      return node.children
        .map((/** @type {any} */ child) =>
          child.nodeType === 3 ? child.nodeValue : child.textContent,
        )
        .join('');
    },
    set(value) {
      node.children = [];
      node._text = String(value ?? '');
    },
  });

  Object.defineProperty(node, 'innerText', {
    get() {
      if (node.children.length === 0) return node._text;
      let out = '';
      for (const child of node.children) {
        if (child.nodeType === 3) {
          out += child.nodeValue;
          continue;
        }
        out += child.innerText;
        if (BLOCKY.has(child.tagName)) out += '\n';
      }
      return out;
    },
  });

  return node;
}

const documentElement = makeElement('html');
const body = makeElement('body');
documentElement.append(body);
markConnected(documentElement, true);

/** 事件监听登记：用例可以手动触发 scroll / visibilitychange */
/** @type {Map<string, Set<Function>>} */
const windowListeners = new Map();
/** @type {Map<string, Set<Function>>} */
const documentListeners = new Map();

function addListener(map, type, fn) {
  const set = map.get(type) || new Set();
  set.add(fn);
  map.set(type, set);
}

function removeListener(map, type, fn) {
  map.get(type)?.delete(fn);
}

function fireListener(map, type) {
  for (const fn of map.get(type) || []) fn({ type });
}

/** MutationObserver 桩：只记录 active 的观察者，测试手动投递记录 */
/** @type {{ callback: Function, active: boolean }[]} */
const mutationObservers = [];

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.active = false;
    mutationObservers.push(this);
  }

  observe() {
    this.active = true;
  }

  disconnect() {
    this.active = false;
  }
}

function fireMutations(records) {
  for (const observer of mutationObservers) {
    if (observer.active) observer.callback(records);
  }
}

const fakeDocument = {
  body,
  documentElement,
  hidden: false,
  createElement: (tag) => makeElement(tag),
  addEventListener(type, fn) {
    addListener(documentListeners, type, fn);
  },
  removeEventListener(type, fn) {
    removeListener(documentListeners, type, fn);
  },
  createTreeWalker(root, _what, filter) {
    const all = [];
    const walk = (node) => {
      for (const kid of node.children ?? []) {
        if (kid.nodeType === 3) all.push(kid);
        else walk(kid);
      }
    };
    walk(root);

    let index = -1;
    return {
      get currentNode() {
        return all[index];
      },
      nextNode() {
        while (index + 1 < all.length) {
          index += 1;
          if (!filter || filter.acceptNode(all[index]) === FILTER_ACCEPT) return true;
        }
        index = all.length;
        return false;
      },
    };
  },
};

/* ------------------------------- 环境桩 ------------------------------- */

let displayMode = 'translation';
let translateScope = 'viewport';
let translator = (text) => text;
/** @type {null | ((texts: string[], call: number) => any)} */
let responder = null;
/** @type {Promise<void> | null} */
let gate = null;
/** @type {null | ((message: any) => any)} */
let reviewResponder = null;
/** @type {Promise<void> | null} */
let reviewGate = null;
/** @type {any[]} */
const reviewCalls = [];
/** @type {((message: any, sender: any, sendResponse: any) => any) | null} */
let listener = null;
/** @type {string[]} */
const seen = [];
let calls = 0;

globalThis.document = fakeDocument;
globalThis.window = {
  innerHeight: 800,
  innerWidth: 1200,
  addEventListener(type, fn) {
    addListener(windowListeners, type, fn);
  },
  removeEventListener(type, fn) {
    removeListener(windowListeners, type, fn);
  },
};
globalThis.MutationObserver = FakeMutationObserver;
globalThis.NodeFilter = { SHOW_TEXT, FILTER_ACCEPT, FILTER_REJECT };
globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(fn) {
        listener = fn;
      },
    },
    async sendMessage(message) {
      if (message.type === 'status') {
        // 用 DeepL 策略（50 段/批、4 路并发）让批次数可预测；
        // 这里只测 content 的分批/并发，不关心真实协议。
        return { ok: true, active: { presetId: 'deepl', protocol: 'deepl' } };
      }
      if (message.type === 'review.run') {
        reviewCalls.push(message);
        if (reviewGate) await reviewGate;
        if (reviewResponder) {
          const result = reviewResponder(message);
          if (result instanceof Error) throw result;
          return result;
        }
        return {
          ok: true,
          corrections: [],
          rejected: [],
          review: {
            reviewed: message.items.length,
            corrected: 0,
            failed: false,
            truncated: false,
          },
        };
      }
      calls += 1;
      if (gate) await gate;
      seen.push(...message.texts);
      if (responder) {
        const result = responder(message.texts, calls);
        if (result instanceof Error) throw result;
        return result;
      }
      return {
        ok: true,
        translations: message.texts.map((text) => translator(text)),
        protected: 0,
        warnings: [],
      };
    },
  },
  storage: {
    local: {
      async get() {
        return {
          settings: {
            displayMode,
            translateScope,
            targetLang: '简体中文',
            targetLangCode: 'ZH-HANS',
          },
        };
      },
    },
  },
};

let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

await import('../extension/content.js');
assert.equal(typeof listener, 'function', 'content.js 应当注册 onMessage 监听器');

/** @param {any} message */
function send(message) {
  return new Promise((resolve) => {
    // @ts-expect-error 桩只实现 sendResponse 这一种用法
    listener(message, {}, resolve);
  });
}

/* ------------------------------- 用例工具 ------------------------------- */

function el(tag, ...kids) {
  const node = makeElement(tag);
  node.append(...kids.map((kid) => (typeof kid === 'string' ? makeText(kid) : kid)));
  return node;
}

function resetBody(...nodes) {
  body.children = [];
  body._text = '';
  body.append(...nodes);
}

/** @returns {any[]} 直接子级里的译文块 */
function directSpans(node) {
  return node.children.filter(
    (child) => child.nodeType === 1 && child.classList.contains('sopen-translated-block'),
  );
}

function allSpans(root = body) {
  return root.querySelectorAll('.sopen-translated-block');
}

/** 每个用例都从干净状态开始 */
async function resetPageStub() {
  await send({ type: 'page.restore' });
  resetBody();
  displayMode = 'translation';
  translateScope = 'viewport';
  fakeDocument.hidden = false;
  windowListeners.clear();
  documentListeners.clear();
  for (const observer of mutationObservers) observer.active = false;
  translator = (text) => `中:${text}`;
  responder = null;
  gate = null;
  reviewResponder = null;
  reviewGate = null;
  reviewCalls.length = 0;
  seen.length = 0;
  calls = 0;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待异步补翻完成，避免用例依赖固定 sleep 时长 */
async function waitFor(check, timeout = 2000) {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeout) throw new Error('等待超时');
    await sleep(10);
  }
}

/* -------------------------------- 用例 -------------------------------- */

await test('初始状态下没有译文记录', async () => {
  await resetPageStub();
  const status = await send({ type: 'page.status' });
  assert.equal(status.translated, 0);
  assert.equal(status.busy, false);
});

await test('纯译文：替换文本节点，链接元素保留且可点', async () => {
  await resetPageStub();
  const link = el('a', 'Link text');
  const para = el('p', 'Read ', link, ' now');
  resetBody(para);

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.translated, 3);
  assert.equal(link.textContent, '中:Link text');
  assert.ok(para.children.includes(link), '链接元素不应被替换掉');
  assert.equal(link.tagName, 'A');
});

await test('纯译文：跳过 pre 与过短文本', async () => {
  await resetPageStub();
  const para = el('p', 'Hello');
  const pre = el('pre', 'code sample');
  const short = el('p', 'x');
  resetBody(para, pre, short);

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.translated, 1);
  assert.equal(pre.textContent, 'code sample');
  assert.equal(short.textContent, 'x');
});

await test('双语 p：span 在 p 内部末尾，原文节点不变', async () => {
  await resetPageStub();
  displayMode = 'bilingual';
  const textNode = makeText('Hello world');
  const para = el('p');
  para.append(textNode);
  resetBody(para);

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.translated, 1);
  assert.equal(directSpans(para).length, 1);
  assert.equal(directSpans(para)[0].textContent, '中:Hello world');
  assert.equal(textNode.nodeValue, 'Hello world', '原文文本节点不应被改写');
});

await test('双语 td：span 在 td 内部，表格结构不变', async () => {
  await resetPageStub();
  displayMode = 'bilingual';
  const cell = el('td', 'Cell text');
  const row = el('tr', cell);
  const table = el('table', el('tbody', row));
  resetBody(table);

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(row.children.length, 1, 'tr 里不应多出 div');
  assert.equal(row.children[0], cell);
  assert.equal(directSpans(cell).length, 1);
});

await test('双语 li：span 在 li 内部，列表项数量不变', async () => {
  await resetPageStub();
  displayMode = 'bilingual';
  const ul = el('ul', el('li', 'Item one'), el('li', 'Item two'));
  resetBody(ul);

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.translated, 2);
  assert.equal(ul.children.length, 2, '列表项数量不应变化');
  assert.equal(allSpans(ul).length, 2);
});

await test('叶子 div：够长的纯文本 div 翻，含 p 的 div 不翻', async () => {
  await resetPageStub();
  displayMode = 'bilingual';
  const leaf = el('div', 'Leaf container text that is long enough to be translated.');
  const innerP = el('p', 'Nested paragraph text');
  const outer = el('div', innerP);
  resetBody(leaf, outer);

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(directSpans(leaf).length, 1, '叶子 div 应当被翻译');
  assert.equal(directSpans(outer).length, 0, '含 p 的 div 不应作为单位');
  assert.equal(directSpans(innerP).length, 1, '交给子级 p');
});

await test('长块：切成 2 段送翻，只插入一个 span 且顺序拼回', async () => {
  await resetPageStub();
  displayMode = 'bilingual';
  const long = '这是第一句。'.repeat(220);
  assert.ok(long.length > 1200);
  const para = el('p', long);
  resetBody(para);
  translator = (text) => `译${text}`;

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(seen.length, 2, '超过 1200 字符应当切成 2 段');
  assert.equal(directSpans(para).length, 1, '一个块只插入一个 span');
  const text = directSpans(para)[0].textContent;
  assert.equal(text.replace(/译/g, ''), long, '分片译文应按顺序拼回');
});

await test('译文与原文相同 / 空译文：不插入 span', async () => {
  await resetPageStub();
  displayMode = 'bilingual';
  const same = el('p', 'Same text');
  const empty = el('p', 'Empty result');
  resetBody(same, empty);
  translator = (text) => (text === 'Same text' ? 'Same text' : '');

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.translated, 0);
  assert.equal(allSpans(body).length, 0);
});

await test('双语 → 还原：span 归零，原文完全复原', async () => {
  await resetPageStub();
  displayMode = 'bilingual';
  const para = el('p', 'Restore me');
  resetBody(para);

  await send({ type: 'page.translate' });
  assert.equal(allSpans(body).length, 1);

  const restore = await send({ type: 'page.restore' });
  assert.equal(restore.ok, true);
  assert.equal(restore.restored, 1);
  assert.equal(allSpans(body).length, 0);
  assert.equal(para.textContent, 'Restore me');
});

await test('双轮：第二轮请求里不含上一轮译文', async () => {
  await resetPageStub();
  displayMode = 'bilingual';
  const para = el('p', 'Round one');
  resetBody(para);

  translator = (text) => `中:${text}`;
  await send({ type: 'page.translate' });
  assert.equal(allSpans(body).length, 1);

  seen.length = 0;
  translator = (text) => `EN:${text}`;
  const second = await send({ type: 'page.translate' });
  assert.equal(second.ok, true, second.error);
  assert.deepEqual(seen, ['Round one']);
  assert.equal(allSpans(body).length, 1, '上一轮的 span 应被移除');
  assert.equal(directSpans(para)[0].textContent, 'EN:Round one');
});

await test('模式互切：纯译文 → 双语 → 还原，原文完全复原', async () => {
  await resetPageStub();
  const para = el('p', 'Switch mode text');
  resetBody(para);

  displayMode = 'translation';
  await send({ type: 'page.translate' });
  assert.equal(para.textContent, '中:Switch mode text');

  displayMode = 'bilingual';
  await send({ type: 'page.translate' });
  assert.equal(allSpans(body).length, 1);
  assert.equal(para.textContent, 'Switch mode text中:Switch mode text');

  const restore = await send({ type: 'page.restore' });
  assert.equal(restore.ok, true);
  assert.equal(allSpans(body).length, 0);
  assert.equal(para.textContent, 'Switch mode text');
});

await test('翻译进行中拒绝还原', async () => {
  await resetPageStub();
  const para = el('p', 'Busy text');
  resetBody(para);

  let open;
  gate = new Promise((resolve) => {
    open = resolve;
  });

  const translating = send({ type: 'page.translate' });
  const busyStatus = await send({ type: 'page.status' });
  assert.equal(busyStatus.busy, true);

  const restore = await send({ type: 'page.restore' });
  assert.equal(restore.ok, false);
  assert.match(restore.error, /正在翻译/);

  gate = null;
  open();
  const result = await translating;
  assert.equal(result.ok, true, result.error);
});

await test('并发：多批同时在飞，结果仍按原文顺序写回', async () => {
  await resetPageStub();
  const paragraphs = Array.from({ length: 120 }, (_, i) => el('p', `word${String(i).padStart(3, '0')}`));
  resetBody(...paragraphs);

  let open;
  gate = new Promise((resolve) => {
    open = resolve;
  });

  const translating = send({ type: 'page.translate' });
  await tick();
  assert.equal(calls, 3, '120 段 / 每批 50 段应当同时起飞 3 批');

  gate = null;
  open();
  const result = await translating;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.translated, 120);
  assert.equal(result.failed, 0);
  assert.equal(paragraphs[0].textContent, '中:word000');
  assert.equal(paragraphs[119].textContent, '中:word119');
});

await test('失败补跑：失败批串行重试一次后补齐', async () => {
  await resetPageStub();
  const paragraphs = Array.from({ length: 120 }, (_, i) => el('p', `word${String(i).padStart(3, '0')}`));
  resetBody(...paragraphs);

  responder = (texts, call) => {
    if (call === 2) return new Error('429');
    return {
      ok: true,
      translations: texts.map((text) => `中:${text}`),
      protected: 0,
      warnings: [],
    };
  };

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.failed, 0, '补跑成功后不应再计失败');
  assert.equal(result.translated, 120);
  assert.equal(calls, 4, '3 批 + 1 次补跑');
  assert.equal(paragraphs[119].textContent, '中:word119');
});

await test('熔断：连续 3 批失败后停止，保留已翻部分', async () => {
  await resetPageStub();
  // 视口策略每批 ≤2000 字符 / 60 段；每段约 48 字符 → 240 段约 6 批，并发 4 会先起飞前 4 批
  const filler = 'x'.repeat(39);
  const paragraphs = Array.from({ length: 240 }, (_, i) =>
    el('p', `word${String(i).padStart(3, '0')} ${filler}`),
  );
  resetBody(...paragraphs);

  responder = (texts, call) => {
    if (call === 1) {
      return {
        ok: true,
        translations: texts.map((text) => `中:${text}`),
        protected: 0,
        warnings: [],
      };
    }
    return new Error('boom');
  };

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.stopped, true);
  assert.ok(result.translated >= 40, `第一批应当保留，实际 ${result.translated}`);
  assert.ok(result.failed >= 100, `至少 3 批失败，实际 ${result.failed}`);
  // 并发下已经在飞的批次无法取消，允许比阈值多带最多 CONCURRENCY-1 批
  assert.ok(calls <= 6, `熔断后不应继续调度，实际 ${calls} 次`);
  assert.equal(paragraphs[0].textContent.startsWith('中:'), true);
  assert.equal(paragraphs[100].textContent.startsWith('word100'), true, '失败批次保持原文');
});

await test('进度：翻译中 total > 0，结束后 done === total', async () => {
  await resetPageStub();
  const first = el('p', 'Progress one');
  const second = el('p', 'Progress two');
  resetBody(first, second);

  let open;
  gate = new Promise((resolve) => {
    open = resolve;
  });

  const translating = send({ type: 'page.translate' });
  await tick();
  const during = await send({ type: 'page.status' });
  assert.equal(during.busy, true);
  assert.ok(during.progress.total > 0);
  assert.equal(during.progress.done, 0);

  gate = null;
  open();
  await translating;

  const after = await send({ type: 'page.status' });
  assert.equal(after.busy, false);
  assert.equal(after.progress.done, after.progress.total);
  assert.equal(after.translated, 2);
});

/* ---------------------------- 视口优先 + 续翻 ---------------------------- */

/** 把元素放到视口外（500px 余量之外） */
function offscreen(node, top = 2000) {
  node.rect = { top, left: 0, right: 100, bottom: top + 20, width: 100, height: 20 };
}

await test('视口优先：只翻视口内文本，滚动后补翻且不重复', async () => {
  await resetPageStub();
  const near = el('p', 'Near text');
  const far = el('p', 'Far text');
  offscreen(far);
  resetBody(near, far);

  const first = await send({ type: 'page.translate' });
  assert.equal(first.ok, true, first.error);
  assert.equal(near.textContent, '中:Near text');
  assert.equal(far.textContent, 'Far text', '视口外不应翻译');

  const initialStatus = await send({ type: 'page.status' });
  assert.equal(initialStatus.scope, 'viewport');
  assert.equal(initialStatus.translated, 1);
  assert.equal(initialStatus.pending, false, '视口外候选不算 pending');
  assert.equal(initialStatus.progress.total, 1, '初次只统计视口段');

  const before = calls;
  far.rect = null;
  fireListener(windowListeners, 'scroll');
  await waitFor(() => far.textContent === '中:Far text');

  assert.equal(calls, before + 1, '滚动补翻只发一次请求');
  assert.equal(near.textContent, '中:Near text', '已翻节点不能被再翻一遍');
  const after = await send({ type: 'page.status' });
  assert.equal(after.translated, 2);
  assert.equal(after.progress.done, after.progress.total);
});

await test('视口优先（双语）：滚动后只给新进入视口的块插入 span', async () => {
  await resetPageStub();
  displayMode = 'bilingual';
  const near = el('p', 'Near block');
  const far = el('p', 'Far block');
  offscreen(far);
  resetBody(near, far);

  const first = await send({ type: 'page.translate' });
  assert.equal(first.ok, true, first.error);
  assert.equal(directSpans(near).length, 1);
  assert.equal(directSpans(far).length, 0);

  far.rect = null;
  fireListener(windowListeners, 'scroll');
  await waitFor(() => directSpans(far).length === 1);
  assert.equal(directSpans(near).length, 1, '已有译文块不能重复插入');
});

await test('整页范围：视口外也一次翻完，且不装滚动观察器', async () => {
  await resetPageStub();
  translateScope = 'whole';
  const near = el('p', 'Whole near');
  const far = el('p', 'Whole far');
  offscreen(far);
  resetBody(near, far);

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(near.textContent, '中:Whole near');
  assert.equal(far.textContent, '中:Whole far');

  const status = await send({ type: 'page.status' });
  assert.equal(status.scope, 'whole');
  const before = calls;
  fireListener(windowListeners, 'scroll');
  await sleep(30);
  assert.equal(calls, before, '整页模式不应有滚动请求');
});

await test('MutationObserver：SPA 新插入的节点会被补翻', async () => {
  await resetPageStub();
  const first = el('p', 'First render');
  resetBody(first);
  await send({ type: 'page.translate' });
  assert.equal(first.textContent, '中:First render');

  const later = el('p', 'Late render');
  body.append(later);
  fireMutations([{ addedNodes: [later], removedNodes: [] }]);
  await waitFor(() => later.textContent === '中:Late render', 3000);
  assert.equal(first.textContent, '中:First render');
});

await test('还原会断开观察器：之后滚动不再发请求', async () => {
  await resetPageStub();
  const near = el('p', 'Near restore');
  const far = el('p', 'Far restore');
  offscreen(far);
  resetBody(near, far);
  await send({ type: 'page.translate' });

  const restore = await send({ type: 'page.restore' });
  assert.equal(restore.ok, true);
  assert.equal(near.textContent, 'Near restore');

  const before = calls;
  far.rect = null;
  fireListener(windowListeners, 'scroll');
  await sleep(50);
  assert.equal(calls, before, '还原后不应再请求');

  const status = await send({ type: 'page.status' });
  assert.equal(status.translated, 0);
  assert.equal(status.pending, false);
});

await test('visibilitychange：隐藏时暂停补翻，恢复后补扫', async () => {
  await resetPageStub();
  const near = el('p', 'Visible tab');
  const far = el('p', 'Hidden tab');
  offscreen(far);
  resetBody(near, far);
  await send({ type: 'page.translate' });

  fakeDocument.hidden = true;
  fireListener(documentListeners, 'visibilitychange');
  far.rect = null;
  fireListener(windowListeners, 'scroll');
  await sleep(80);
  assert.equal(far.textContent, 'Hidden tab', '隐藏标签页不应继续烧 token');

  fakeDocument.hidden = false;
  fireListener(documentListeners, 'visibilitychange');
  await waitFor(() => far.textContent === '中:Hidden tab');
});

await test('异步审校：translate 立即返回并渲染，审校响应后按 id 打补丁', async () => {
  await resetPageStub();
  const para = el('p', 'Kubernetes runs containers.');
  resetBody(para);

  /** @type {() => void} */
  let release = () => {};
  reviewGate = new Promise((resolve) => {
    release = () => resolve();
  });
  responder = (texts) => ({
    ok: true,
    translations: texts.map((text) => `中:${text}`),
    protected: 0,
    warnings: [],
    reviewCandidates: [{ index: 0, reasons: ['term'], missing: ['Kubernetes'] }],
  });
  reviewResponder = (message) => ({
    ok: true,
    corrections: [{ id: message.items[0].id, corrected: 'Kubernetes 运行容器。' }],
    rejected: [],
    review: { reviewed: 1, corrected: 1, failed: false, truncated: false },
  });

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  // 审校还卡在 gate 上，首屏已经渲染完
  assert.equal(para.textContent, '中:Kubernetes runs containers.');
  const during = await send({ type: 'page.status' });
  assert.equal(during.translated, 1);
  assert.equal(during.review.pending, true);
  assert.equal(during.review.reviewed, 0);

  await waitFor(() => reviewCalls.length === 1);
  assert.equal(reviewCalls[0].items[0].source, 'Kubernetes runs containers.');
  assert.equal(reviewCalls[0].items[0].primary, '中:Kubernetes runs containers.');
  assert.equal(reviewCalls[0].target, '简体中文');
  assert.equal(reviewCalls[0].targetCode, 'ZH-HANS');
  assert.deepEqual(reviewCalls[0].items[0].reasons, ['term']);

  release();
  await waitFor(() => para.textContent === 'Kubernetes 运行容器。');
  const after = await send({ type: 'page.status' });
  assert.equal(after.review.pending, false);
  assert.equal(after.review.reviewed, 1);
  assert.equal(after.review.corrected, 1);
});

await test('异步审校：还原后晚到的响应被 generation 丢弃', async () => {
  await resetPageStub();
  const para = el('p', 'Kubernetes runs containers.');
  resetBody(para);

  /** @type {() => void} */
  let release = () => {};
  reviewGate = new Promise((resolve) => {
    release = () => resolve();
  });
  responder = (texts) => ({
    ok: true,
    translations: texts.map((text) => `中:${text}`),
    protected: 0,
    warnings: [],
    reviewCandidates: [{ index: 0, reasons: ['term'], missing: ['Kubernetes'] }],
  });
  reviewResponder = (message) => ({
    ok: true,
    corrections: [{ id: message.items[0].id, corrected: 'Kubernetes 运行容器。' }],
    rejected: [],
    review: { reviewed: 1, corrected: 1, failed: false, truncated: false },
  });

  await send({ type: 'page.translate' });
  await waitFor(() => reviewCalls.length === 1);

  const restore = await send({ type: 'page.restore' });
  assert.equal(restore.ok, true);
  release();
  await sleep(80);

  assert.equal(para.textContent, 'Kubernetes runs containers.', '还原后不能被迟到的修正污染');
  const status = await send({ type: 'page.status' });
  assert.equal(status.review.reviewed, 0);
  assert.equal(status.review.corrected, 0);
});

await test('异步审校（双语）：只改对应 chunk，重新 join 后 span 正确', async () => {
  await resetPageStub();
  displayMode = 'bilingual';
  const long = '这是第一句。'.repeat(220);
  assert.ok(long.length > 1200);
  const para = el('p', long);
  resetBody(para);

  responder = (texts) => ({
    ok: true,
    translations: texts.map((text) => `译${text}`),
    protected: 0,
    warnings: [],
    // 第二个 chunk 可疑
    reviewCandidates: [{ index: 1, reasons: ['length'], missing: [] }],
  });
  reviewResponder = (message) => ({
    ok: true,
    corrections: [{ id: message.items[0].id, corrected: '修正后的第二段。' }],
    rejected: [],
    review: { reviewed: 1, corrected: 1, failed: false, truncated: false },
  });

  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(directSpans(para).length, 1);
  const before = directSpans(para)[0].textContent;

  await waitFor(() => directSpans(para)[0].textContent !== before, 3000);
  const span = directSpans(para)[0];
  assert.equal(para.children.filter((child) => child.tagName === 'SPAN').length, 1, '仍然只有一个 span');
  assert.ok(span.textContent.endsWith('修正后的第二段。'), span.textContent);
  assert.ok(span.textContent.startsWith('译这是第一句。'), '第一段译文不受影响');
});

await test('异步审校：undo 只把 applied 的修正换回主译文', async () => {
  await resetPageStub();
  const first = el('p', 'Kubernetes runs containers.');
  const second = el('p', 'Kubernetes runs pods.');
  resetBody(first, second);

  responder = (texts) => ({
    ok: true,
    translations: texts.map((text) => `中:${text}`),
    protected: 0,
    warnings: [],
    reviewCandidates: [
      { index: 0, reasons: ['term'], missing: ['Kubernetes'] },
      { index: 1, reasons: ['term'], missing: ['Kubernetes'] },
    ],
  });
  reviewResponder = (message) => ({
    ok: true,
    // 只修正第一条；第二条保持主译文
    corrections: [{ id: message.items[0].id, corrected: 'Kubernetes 运行容器。' }],
    rejected: [{ id: message.items[1].id, reason: 'unchanged' }],
    review: { reviewed: 2, corrected: 1, failed: false, truncated: false },
  });

  await send({ type: 'page.translate' });
  await waitFor(() => first.textContent === 'Kubernetes 运行容器。');
  assert.equal(second.textContent, '中:Kubernetes runs pods.');

  const review = await send({ type: 'page.review' });
  assert.equal(review.ok, true);
  assert.equal(review.summary.corrected, 1);
  assert.equal(review.summary.rejected, 1);
  assert.equal(review.log.length, 2);
  assert.equal(review.log[0].applied, true);
  assert.equal(review.log[1].applied, false);

  const undo = await send({ type: 'page.review.undo' });
  assert.equal(undo.ok, true);
  assert.equal(undo.undone, 1);
  assert.equal(first.textContent, '中:Kubernetes runs containers.');
  assert.equal(second.textContent, '中:Kubernetes runs pods.', '未 applied 的不动');

  const after = await send({ type: 'page.review' });
  assert.equal(after.summary.corrected, 0);
});

await test('异步审校：失败退避一次，仍失败则保留主译文并标记 failed', async () => {
  await resetPageStub();
  const para = el('p', 'Kubernetes runs containers.');
  resetBody(para);

  responder = (texts) => ({
    ok: true,
    translations: texts.map((text) => `中:${text}`),
    protected: 0,
    warnings: [],
    reviewCandidates: [{ index: 0, reasons: ['term'], missing: ['Kubernetes'] }],
  });
  reviewResponder = () => new Error('review down');

  await send({ type: 'page.translate' });
  await waitFor(() => reviewCalls.length === 2, 4000);
  const status = await send({ type: 'page.status' });
  assert.equal(status.review.failed, true);
  assert.equal(status.review.pending, false);
  assert.equal(para.textContent, '中:Kubernetes runs containers.');
});

await test('异步审校：节点断开时跳过补丁，不写错节点', async () => {
  await resetPageStub();
  const para = el('p', 'Kubernetes runs containers.');
  const other = el('p', 'Kubernetes runs pods.');
  resetBody(para, other);

  /** @type {() => void} */
  let release = () => {};
  reviewGate = new Promise((resolve) => {
    release = () => resolve();
  });
  responder = (texts) => ({
    ok: true,
    translations: texts.map((text) => `中:${text}`),
    protected: 0,
    warnings: [],
    reviewCandidates: [{ index: 0, reasons: ['term'], missing: ['Kubernetes'] }],
  });
  reviewResponder = (message) => ({
    ok: true,
    corrections: [{ id: message.items[0].id, corrected: 'Kubernetes 运行容器。' }],
    rejected: [],
    review: { reviewed: 1, corrected: 1, failed: false, truncated: false },
  });

  await send({ type: 'page.translate' });
  await waitFor(() => reviewCalls.length === 1);
  para.remove();
  release();
  await sleep(120);

  assert.equal(other.textContent, '中:Kubernetes runs pods.', '不能把译文写到别的节点');
  const review = await send({ type: 'page.review' });
  assert.equal(review.summary.corrected, 0);
  assert.equal(review.log[0].applied, false);
  assert.equal(review.log[0].rejectedReason, 'detached');
});

await test('异步审校：LLM 主翻译 / 空候选都不产生 review.run', async () => {
  await resetPageStub();
  const para = el('p', 'Kubernetes runs containers.');
  resetBody(para);

  responder = (texts) => ({
    ok: true,
    translations: texts.map((text) => `中:${text}`),
    protected: 0,
    warnings: [],
    reviewSkipped: 'llm-primary',
    reviewCandidates: [],
  });

  await send({ type: 'page.translate' });
  await sleep(600);
  assert.equal(reviewCalls.length, 0, 'LLM 主翻译不应发审校请求');

  responder = (texts) => ({
    ok: true,
    translations: texts.map((text) => `中:${text}`),
    protected: 0,
    warnings: [],
    reviewCandidates: [],
  });
  await send({ type: 'page.restore' });
  await send({ type: 'page.translate' });
  await sleep(600);
  assert.equal(reviewCalls.length, 0, '空候选不应发审校请求');
});

if (failures > 0) {
  console.log(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
process.exit(0);
