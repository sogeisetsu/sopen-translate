/**
 * content script 冒烟测试：用一个最小假 DOM 直接加载 extension/content.js，
 * 验证「两轮翻译 → 还原」的状态机，以及翻译进行中拒绝还原。
 *
 * 跑法：npm run smoke:dom
 * 这不是 DOM 实现，只是够 content.js 跑起来的桩：TreeWalker 的过滤语义按
 * 「只遍历文本节点」实现，够用但不通用。
 */

import assert from 'node:assert/strict';

const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const SHOW_TEXT = 4;

function makeText(value) {
  return { nodeType: 3, nodeValue: value, parentElement: null };
}

function markConnected(node) {
  node.isConnected = true;
  if (node.nodeType === 1) for (const kid of node.children) markConnected(kid);
}

function makeElement(tagName) {
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    children: [],
    parentElement: null,
    isContentEditable: false,
    isConnected: false,
    id: '',
    className: '',
    hidden: false,
    textContent: '',
    append(...kids) {
      for (const kid of kids) {
        kid.parentElement = node;
        node.children.push(kid);
        markConnected(kid);
      }
    },
    appendChild(kid) {
      node.append(kid);
    },
    setAttribute() {},
    classList: { toggle() {}, add() {}, remove() {} },
    closest(selector) {
      let current = node;
      while (current) {
        if (selector.startsWith('#') && current.id === selector.slice(1)) return current;
        current = current.parentElement;
      }
      return null;
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
  };
  return node;
}

/* ------------------------------- 假 DOM ------------------------------- */

const documentElement = makeElement('html');
const body = makeElement('body');
documentElement.append(body);

const hello = makeText('Hello');
const world = makeText('World');
const kept = makeText('should stay');
const keptByTag = makeText('code sample');

const paragraph = makeElement('p');
const pre = makeElement('pre');
body.append(hello, paragraph, pre);
paragraph.append(world);
pre.append(keptByTag);
body.append(kept);
kept.nodeValue = 'x'; // 单字符，低于最小长度，应被跳过
keptByTag.nodeValue = 'code sample';

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

let translator = (text) => text;
let gate = null;
let listener = null;

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
      if (gate) await gate;
      return { ok: true, translations: message.texts.map((text) => translator(text)) };
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
    listener(message, {}, resolve);
  });
}

await test('初始状态下没有译文记录', async () => {
  const status = await send({ type: 'page.status' });
  assert.equal(status.translated, 0);
  assert.equal(hello.nodeValue, 'Hello');
});

await test('第一轮翻译替换了文本，跳过 pre 与过短文本', async () => {
  translator = (text) => `中:${text}`;
  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.translated, 2);
  assert.equal(hello.nodeValue, '中:Hello');
  assert.equal(world.nodeValue, '中:World');
  assert.equal(keptByTag.nodeValue, 'code sample');
  assert.equal(kept.nodeValue, 'x');
});

await test('第二轮从原文出发，不会把上一轮译文再翻一遍', async () => {
  /** @type {string[]} */
  const seen = [];
  translator = (text) => {
    seen.push(text);
    return `EN:${text}`;
  };
  const result = await send({ type: 'page.translate' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(seen.sort(), ['Hello', 'World']);
  assert.equal(result.translated, 2, '计数不应累计上一轮');
  assert.equal(hello.nodeValue, 'EN:Hello');
  assert.equal(world.nodeValue, 'EN:World');
});

await test('两轮之后还原，节点回到原文', async () => {
  const result = await send({ type: 'page.restore' });
  assert.equal(result.ok, true);
  assert.equal(result.restored, 2);
  assert.equal(hello.nodeValue, 'Hello');
  assert.equal(world.nodeValue, 'World');
  assert.equal(keptByTag.nodeValue, 'code sample');

  const status = await send({ type: 'page.status' });
  assert.equal(status.translated, 0);
});

await test('翻译进行中拒绝还原', async () => {
  translator = (text) => `中:${text}`;
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

await test('还原后页面状态干净', async () => {
  const restore = await send({ type: 'page.restore' });
  assert.equal(restore.restored, 2);
  assert.equal(hello.nodeValue, 'Hello');
  assert.equal(world.nodeValue, 'World');
});

if (failures > 0) {
  console.log(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
process.exit(0);
