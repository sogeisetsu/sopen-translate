/**
 * provider 层冒烟测试：stub 掉 fetch，不联网、不需要真实密钥。
 *
 * 跑法：npm run smoke
 * 目的：锁住「原序返回等长数组」这条契约，以及 response_format 的回退路径。
 */

import assert from 'node:assert/strict';
import { getProviderType } from '../extension/lib/providers.js';

let failures = 0;
let current = '';

const openaiConfig = { id: 't', type: 'openai', baseUrl: 'https://api.test/v1/', model: 'm' };
const deeplConfig = { id: 't', type: 'deepl', baseUrl: 'https://api.test', apiKey: 'k' };

/** @param {string} name @param {() => Promise<void>} fn */
async function test(name, fn) {
  current = name;
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 让 openai.translate 收到一段模型返回 */
function stubOpenAI(contentFor) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const content = contentFor(body, calls.length);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  return calls;
}

const plainContent = (body) => {
  const { segments } = JSON.parse(body.messages[1].content);
  return JSON.stringify({ segments: segments.map((segment) => `译:${segment}`) });
};

await test('openai：正常返回，顺序与长度保持', async () => {
  stubOpenAI(plainContent);
  const out = await getProviderType('openai').translate({
    texts: ['a', 'b'],
    config: openaiConfig,
    target: '中文',
    targetCode: 'ZH',
  });
  assert.deepEqual(out, ['译:a', '译:b']);
});

await test('openai：兼容代码块包裹的 JSON', async () => {
  stubOpenAI((body) => '```json\n' + plainContent(body) + '\n```');
  const out = await getProviderType('openai').translate({
    texts: ['a'],
    config: openaiConfig,
    target: '中文',
    targetCode: 'ZH',
  });
  assert.deepEqual(out, ['译:a']);
});

await test('openai：接口拒绝 response_format 时回退重试', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.response_format) return new Response('unsupported', { status: 400 });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: plainContent(body) } }] }),
      { status: 200 },
    );
  };
  const out = await getProviderType('openai').translate({
    texts: ['a'],
    config: openaiConfig,
    target: '中文',
    targetCode: 'ZH',
  });
  assert.deepEqual(out, ['译:a']);
  assert.equal(calls.length, 2, '应当先带 response_format 再回退');
  assert.equal(calls[1].response_format, undefined);
});

await test('openai：分段数不符必须抛错', async () => {
  stubOpenAI(() => JSON.stringify({ segments: ['only-one'] }));
  await assert.rejects(
    getProviderType('openai').translate({
      texts: ['a', 'b'],
      config: openaiConfig,
      target: '中文',
      targetCode: 'ZH',
    }),
    /分段数不符/,
  );
});

await test('openai：无法解析的返回必须抛错', async () => {
  stubOpenAI(() => '抱歉，我不能这样做。');
  await assert.rejects(
    getProviderType('openai').translate({
      texts: ['a'],
      config: openaiConfig,
      target: '中文',
      targetCode: 'ZH',
    }),
    /无法解析/,
  );
});

await test('openai：HTTP 错误透出状态码', async () => {
  globalThis.fetch = async () => new Response('bad key', { status: 401 });
  await assert.rejects(
    getProviderType('openai').translate({
      texts: ['a'],
      config: openaiConfig,
      target: '中文',
      targetCode: 'ZH',
    }),
    /HTTP 401/,
  );
});

await test('openai：连接失败给出可读错误', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('bad url');
  };
  await assert.rejects(
    getProviderType('openai').translate({
      texts: ['a'],
      config: openaiConfig,
      target: '中文',
      targetCode: 'ZH',
    }),
    /无法连接/,
  );
});

await test('deepl：正常返回保持顺序', async () => {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.target_lang, 'ZH');
    return new Response(
      JSON.stringify({ translations: body.text.map((text) => ({ text: `译:${text}` })) }),
      { status: 200 },
    );
  };
  const out = await getProviderType('deepl').translate({
    texts: ['a', 'b'],
    config: deeplConfig,
    target: '中文',
    targetCode: 'ZH',
  });
  assert.deepEqual(out, ['译:a', '译:b']);
});

await test('deepl：分段数不符必须抛错', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ translations: [{ text: 'only-one' }] }), { status: 200 });
  await assert.rejects(
    getProviderType('deepl').translate({
      texts: ['a', 'b'],
      config: deeplConfig,
      target: '中文',
      targetCode: 'ZH',
    }),
    /分段数不符/,
  );
});

if (failures > 0) {
  console.log(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
