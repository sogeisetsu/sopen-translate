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
    _text: '',
    _attrs: {},

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

const fakeDocument = {
  body,
  documentElement,
  createElement: (tag) => makeElement(tag),
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
let translator = (text) => text;
/** @type {null | ((texts: string[], call: number) => any)} */
let responder = null;
/** @type {Promise<void> | null} */
let gate = null;
/** @type {((message: any, sender: any, sendResponse: any) => any) | null} */
let listener = null;
/** @type {string[]} */
const seen = [];
let calls = 0;

globalThis.document = fakeDocument;
globalThis.window = {};
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
        return { settings: { displayMode } };
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
  translator = (text) => `中:${text}`;
  responder = null;
  gate = null;
  seen.length = 0;
  calls = 0;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  // 每段约 48 字符、每批 50 段 → 240 段 = 5 批；并发 4 会先起飞前 4 批
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
  assert.ok(result.translated >= 50, `第一批的 50 段应当保留，实际 ${result.translated}`);
  assert.ok(result.failed >= 150, `至少 3 批失败，实际 ${result.failed}`);
  // 并发下已经在飞的批次无法取消，允许比阈值多带最多 CONCURRENCY-1 批
  assert.ok(calls <= 5, `熔断后不应继续调度，实际 ${calls} 次`);
  assert.equal(paragraphs[0].textContent.startsWith('中:'), true);
  assert.equal(paragraphs[50].textContent.startsWith('word050'), true, '失败批次保持原文');
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

if (failures > 0) {
  console.log(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
process.exit(0);
