/**
 * provider 层冒烟测试：stub 掉 fetch，不联网、不需要真实密钥。
 *
 * 跑法：npm run smoke
 * 目的：锁住「原序返回等长数组」这条契约、协议解析、模型列表回退、
 * 术语保护三档策略，以及旧设置迁移。
 *
 * 只 import `lib/*.js` 与 `providers.js`，不 import `background.js`
 * （service worker 依赖 chrome.*）。
 */

import assert from 'node:assert/strict';
import { getProviderType, reviewTranslations, translateBatch } from '../extension/lib/providers.js';
import { loadModelList, parseModelList, resolveModelsUrl } from '../extension/lib/models.js';
import { normalizeSettings, migrateSettings } from '../extension/lib/settings.js';
import { compileGlossary, matchTerms, modelTokens } from '../extension/lib/glossary.js';
import { reasoningOffParams } from '../extension/lib/reasoning.js';
import { microsoftCode } from '../extension/lib/languages.js';
import { findSuspicious, REVIEW_MAX_SEGMENTS } from '../extension/lib/review.js';

let failures = 0;

/** @param {string} name @param {() => Promise<void>} fn */
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err instanceof Error ? err.stack : String(err)}`);
  }
}

const openaiConfig = { id: 't', type: 'openai', baseUrl: 'https://api.test/v1/', model: 'm' };
const deeplConfig = { id: 't', type: 'deepl', baseUrl: 'https://api.test', apiKey: 'k' };

const chatConfig = {
  id: 't',
  presetId: 'custom',
  protocol: 'openai-chat',
  baseUrl: 'https://api.test/v1',
  model: 'm',
  apiKey: 'k',
};

const chatDeeplConfig = {
  id: 't',
  presetId: 'deepl',
  protocol: 'deepl',
  baseUrl: 'https://api.test',
  apiKey: 'k',
};

/** @typedef {{ url: string, body: any, headers: any }} Call */

/**
 * 让 openai-chat / 兼容入口收到一段模型返回
 * @param {(body: any, callIndex: number) => string} contentFor
 * @returns {Call[]}
 */
function stubOpenAI(contentFor) {
  /** @type {Call[]} */
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    const content = contentFor(body, calls.length);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  return calls;
}

const plainContent = (body) => {
  const { segments } = JSON.parse(body.messages[1].content);
  return JSON.stringify({ segments: segments.map((segment) => `译:${segment}`) });
};

const segmentsOf = (body) => JSON.parse(body.messages[1].content).segments;
const systemOf = (body) => body.messages[0].content;

const chatResult = (segments) =>
  JSON.stringify({ choices: [{ message: { content: JSON.stringify({ segments }) } }] });

/* ------------------------------ 既有用例 ------------------------------ */

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

await test('openai：401 时不触发 response_format 回退', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('bad key', { status: 401 });
  };
  await assert.rejects(
    translateBatch({
      texts: ['a'],
      config: chatConfig,
      target: '中文',
      targetCode: 'ZH',
    }),
    /HTTP 401/,
  );
  assert.equal(calls, 1, '401 只应发一次');
});

await test('openai：单段仍不符必须抛错（二分到底也不对）', async () => {
  stubOpenAI(() => JSON.stringify({ segments: [] }));
  await assert.rejects(
    getProviderType('openai').translate({
      texts: ['a'],
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

/* ------------------------------ 协议解析 ------------------------------ */

await test('anthropic-messages：解析 content[].text，用 x-api-key', async () => {
  /** @type {Call[]} */
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ segments: ['甲'] }) }] }),
      { status: 200 },
    );
  };
  const out = await getProviderType('anthropic-messages').translate({
    texts: ['a'],
    config: { id: 'a', presetId: 'custom', protocol: 'anthropic-messages', baseUrl: 'https://api.test/v1', model: 'claude', apiKey: 'k' },
    target: '中文',
    targetCode: 'ZH',
  });
  assert.deepEqual(out, ['甲']);
  assert.match(calls[0].url, /\/messages$/);
  assert.equal(calls[0].headers['x-api-key'], 'k');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].headers.Authorization, undefined);
});

await test('google-gemini：解析 candidates[0].content.parts，key 走 query', async () => {
  /** @type {Call[]} */
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ segments: ['乙'] }) }] } }],
      }),
      { status: 200 },
    );
  };
  const out = await getProviderType('google-gemini').translate({
    texts: ['a'],
    config: { id: 'g', presetId: 'custom', protocol: 'google-gemini', baseUrl: 'https://api.test/v1beta', model: 'gemini', apiKey: 'k' },
    target: '中文',
    targetCode: 'ZH',
  });
  assert.deepEqual(out, ['乙']);
  assert.match(calls[0].url, /:generateContent\?key=k$/);
});

await test('openai-responses：解析 output[].content[].text', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ segments: ['丙'] }) }] }],
      }),
      { status: 200 },
    );
  const out = await getProviderType('openai-responses').translate({
    texts: ['a'],
    config: { id: 'r', presetId: 'custom', protocol: 'openai-responses', baseUrl: 'https://api.test/v1', model: 'gpt', apiKey: 'k' },
    target: '中文',
    targetCode: 'ZH',
  });
  assert.deepEqual(out, ['丙']);
});

/* ------------------------------ 模型列表 ------------------------------ */

await test('parseModelList：4 种形状 + 去重排序', async () => {
  assert.deepEqual(parseModelList({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(parseModelList({ data: [{ name: 'b' }, { name: 'a' }] }), ['a', 'b']);
  assert.deepEqual(parseModelList({ models: [{ name: 'b' }, { name: 'a' }] }), ['a', 'b']);
  assert.deepEqual(parseModelList({ models: [{ id: 'b' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(parseModelList(['b', 'a', 'b']), ['a', 'b']);
  assert.deepEqual(parseModelList({ unexpected: true }), []);
});

await test('loadModelList：网络失败/空列表回退预设且不抛错', async () => {
  const preset = {
    id: 'x',
    label: 'X',
    protocol: 'openai-chat',
    baseUrl: 'https://api.test/v1',
    models: ['fallback-1'],
    supportsModelList: true,
    verified: false,
  };
  const config = { id: 'x', presetId: 'x', protocol: 'openai-chat', baseUrl: 'https://api.test/v1' };

  globalThis.fetch = async () => {
    throw new TypeError('offline');
  };
  assert.deepEqual(await loadModelList({ config, preset }), {
    models: ['fallback-1'],
    from: 'preset',
  });

  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  assert.deepEqual(await loadModelList({ config, preset }), {
    models: ['fallback-1'],
    from: 'preset',
  });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ id: 'real-1' }] }), { status: 200 });
  assert.deepEqual(await loadModelList({ config, preset }), {
    models: ['real-1'],
    from: 'network',
  });
});

await test('resolveModelsUrl：OpenCode Go 用独立的 /v1/models', async () => {
  const config = {
    id: 'g',
    presetId: 'opencode-go',
    protocol: 'openai-chat',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
  };
  assert.equal(resolveModelsUrl(config), 'https://opencode.ai/inference/go/v1/models');
  assert.equal(
    resolveModelsUrl({ ...config, modelsUrl: 'https://custom.test/models' }),
    'https://custom.test/models',
  );
});

await test('openai-chat：extraHeaders 带 x-opencode-session', async () => {
  /** @type {Call[]} */
  const calls = stubOpenAI(plainContent);
  await translateBatch({
    texts: ['a'],
    config: chatConfig,
    target: '中文',
    targetCode: 'ZH',
    extraHeaders: { 'x-opencode-session': 'session-123' },
  });
  assert.equal(calls[0].headers['x-opencode-session'], 'session-123');
  assert.equal(calls[0].headers.Authorization, 'Bearer k');
});

/* ------------------------------ 429 退避 ------------------------------ */

await test('429：前两次 429、第三次 200，退避后成功', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    if (calls < 3) return new Response('rate limited', { status: 429 });
    const body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: plainContent(body) } }] }),
      { status: 200 },
    );
  };
  const out = await getProviderType('openai-chat').translate({
    texts: ['a'],
    config: chatConfig,
    target: '中文',
    targetCode: 'ZH',
    retry: { delays: [0, 0, 0] },
  });
  assert.deepEqual(out, ['译:a']);
  assert.equal(calls, 3);
});

await test('429：连续失败抛 HTTP 429，且不触发 response_format 回退', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('rate limited', { status: 429 });
  };
  await assert.rejects(
    getProviderType('openai-chat').translate({
      texts: ['a'],
      config: chatConfig,
      target: '中文',
      targetCode: 'ZH',
      retry: { delays: [0, 0, 0] },
    }),
    /HTTP 429/,
  );
  assert.equal(calls, 4, '1 次初始 + 3 次重试，不应再叠加 response_format 回退');
});

await test('429：不会触发二分重试（只有截断才拆批）', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('rate limited', { status: 429 });
  };
  await assert.rejects(
    translateBatch({
      texts: ['a', 'b'],
      config: chatConfig,
      target: '中文',
      targetCode: 'ZH',
      retry: { delays: [0, 0, 0] },
    }),
    /HTTP 429/,
  );
  assert.equal(calls, 4, '2 段 429 也只应有 1+3 次请求，不能拆成两批放大');
});

await test('截断自适应：分段数不符时二分重试并保持顺序', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls += 1;
    const segments = JSON.parse(body.messages[1].content).segments;
    // 第一次故意少返回一段，模拟输出被截断
    const out =
      calls === 1 ? segments.slice(0, Math.max(0, segments.length - 1)) : segments.map((s) => `译:${s}`);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ segments: out }) } }] }),
      { status: 200 },
    );
  };

  const result = await translateBatch({
    texts: ['first text', 'second text'],
    config: chatConfig,
    target: '中文',
    targetCode: 'ZH',
  });

  assert.deepEqual(result.translations, ['译:first text', '译:second text']);
  assert.equal(calls, 3, '1 次整批 + 2 次二分');
});

await test('思考开关：按预设/模型映射，强制思考的不发字段', async () => {
  assert.deepEqual(reasoningOffParams('opencode-go', 'deepseek-v4.1-flash'), {
    reasoning_effort: 'none',
  });
  assert.equal(reasoningOffParams('opencode-go', 'glm-5.3'), null);
  assert.equal(reasoningOffParams('opencode-go', 'kimi-k3'), null);
  assert.deepEqual(reasoningOffParams('deepseek', 'deepseek-flash'), {
    thinking: { type: 'disabled' },
  });
  assert.equal(reasoningOffParams('kimi', 'kimi-k3'), null);
  assert.deepEqual(reasoningOffParams('kimi', 'kimi-k2.6'), {
    thinking: { type: 'disabled' },
  });
  assert.equal(reasoningOffParams('zhipu', 'glm-5.3'), null);
  assert.deepEqual(reasoningOffParams('zhipu', 'glm-5.2'), {
    thinking: { type: 'disabled' },
  });
  assert.equal(reasoningOffParams('minimax', 'MiniMax-M3.1-Flash'), null);
  assert.deepEqual(reasoningOffParams('minimax', 'MiniMax-M3'), {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(reasoningOffParams('dashscope', 'qwen3.8-flash'), { enable_thinking: false });
  assert.deepEqual(reasoningOffParams('openrouter', 'openrouter/auto'), {
    reasoning: { enabled: false },
  });
  assert.deepEqual(reasoningOffParams('siliconflow', 'deepseek-ai/DeepSeek-V4-Flash'), {
    enable_thinking: false,
  });
  assert.deepEqual(reasoningOffParams('sensenova', 'sensenova-6.8-flash-lite'), {
    reasoning: { enabled: false },
  });
  assert.equal(reasoningOffParams('custom', 'm'), null);
});

await test('openai-chat：OpenCode Go 请求体带 reasoning_effort=none', async () => {
  const calls = stubOpenAI(plainContent);
  await translateBatch({
    texts: ['a'],
    config: {
      id: 'r',
      presetId: 'opencode-go',
      protocol: 'openai-chat',
      baseUrl: 'https://api.test/reasoning-body',
      model: 'deepseek-v4.1-flash',
      apiKey: 'k',
    },
    target: '中文',
    targetCode: 'ZH',
  });
  assert.equal(calls[0].body.reasoning_effort, 'none');
});

await test('思考字段被 400 时：先只去掉它，并记住该配置', async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.reasoning_effort) return new Response('unsupported', { status: 400 });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: plainContent(body) } }] }),
      { status: 200 },
    );
  };
  const config = {
    id: 'r',
    presetId: 'opencode-go',
    protocol: 'openai-chat',
    baseUrl: 'https://api.test/reasoning-fallback',
    model: 'deepseek-test',
    apiKey: 'k',
  };

  const first = await translateBatch({ texts: ['a'], config, target: '中文', targetCode: 'ZH' });
  assert.deepEqual(first.translations, ['译:a']);
  assert.equal(calls.length, 2, '1 次带思考 + 1 次去掉思考');
  assert.equal(calls[0].reasoning_effort, 'none');
  assert.equal(calls[1].reasoning_effort, undefined);
  assert.ok(calls[1].response_format, '去掉思考时仍应保留 response_format');

  // 同一个配置的下一批不应再发思考字段
  const before = calls.length;
  await translateBatch({ texts: ['b'], config, target: '中文', targetCode: 'ZH' });
  assert.equal(calls.length, before + 1);
  assert.equal(calls[calls.length - 1].reasoning_effort, undefined);
});

await test('思考开关：http.js 的 429 重试不受影响', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('rate limited', { status: 429 });
  };
  await assert.rejects(
    translateBatch({
      texts: ['a'],
      config: {
        id: 'r',
        presetId: 'opencode-go',
        protocol: 'openai-chat',
        baseUrl: 'https://api.test/reasoning-429',
        model: 'deepseek-test',
        apiKey: 'k',
      },
      target: '中文',
      targetCode: 'ZH',
      retry: { delays: [0, 0, 0] },
    }),
    /HTTP 429/,
  );
  assert.equal(calls, 4);
});

/* ------------------------------ 术语保护 ------------------------------ */

await test('pipeline：命中术语时注入 system prompt', async () => {
  /** @type {Call[]} */
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: '', body, headers: init.headers });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ segments: ['使用 Kubernetes 部署'] }) } }],
      }),
      { status: 200 },
    );
  };
  await translateBatch({
    texts: ['使用 Kubernetes 部署'],
    config: chatConfig,
    target: '中文',
    targetCode: 'ZH',
    glossary: ['Kubernetes'],
  });
  assert.match(systemOf(calls[0].body), /Kubernetes/);
});

await test('pipeline fallback：缺词的段替换成原文', async () => {
  stubOpenAI((body) => JSON.stringify({ segments: segmentsOf(body).map(() => '简介') }));
  const result = await translateBatch({
    texts: ['Kubernetes 简介'],
    config: chatConfig,
    target: '中文',
    targetCode: 'ZH',
    glossary: ['Kubernetes'],
    enforcement: 'fallback',
  });
  assert.deepEqual(result.translations, ['Kubernetes 简介']);
  assert.equal(result.protected, 1);
  assert.deepEqual(result.warnings, []);
});

await test('pipeline repair：只重发失败段并补齐', async () => {
  /** @type {Call[]} */
  const calls = stubOpenAI((body, callIndex) => {
    const segments = segmentsOf(body);
    return JSON.stringify({
      segments:
        callIndex === 1
          ? segments.map((segment) =>
              segment.includes('Kubernetes') ? '漏词' : `译:${segment}`,
            )
          : segments.map((segment) => `译:${segment}`),
    });
  });
  const result = await translateBatch({
    texts: ['safe thing', 'has Kubernetes'],
    config: chatConfig,
    target: '中文',
    targetCode: 'ZH',
    glossary: ['Kubernetes'],
    enforcement: 'repair',
  });
  assert.deepEqual(result.translations, ['译:safe thing', '译:has Kubernetes']);
  assert.equal(result.protected, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(segmentsOf(calls[1].body), ['has Kubernetes']);
});

await test('pipeline warn：保留译文并回报缺词', async () => {
  stubOpenAI((body) => JSON.stringify({ segments: segmentsOf(body).map(() => '简介') }));
  const result = await translateBatch({
    texts: ['Kubernetes 简介'],
    config: chatConfig,
    target: '中文',
    targetCode: 'ZH',
    glossary: ['Kubernetes'],
    enforcement: 'warn',
  });
  assert.deepEqual(result.translations, ['简介']);
  assert.equal(result.protected, 0);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.warnings[0].missing, ['Kubernetes']);
});

await test('DeepL + glossary：不注入、不校验、不回退', async () => {
  /** @type {Call[]} */
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ translations: [{ text: '简介' }] }), { status: 200 });
  };
  const result = await translateBatch({
    texts: ['Kubernetes 简介'],
    config: chatDeeplConfig,
    target: '中文',
    targetCode: 'ZH-HANS',
    glossary: ['Kubernetes'],
    enforcement: 'fallback',
  });
  assert.deepEqual(result.translations, ['简介']);
  assert.equal(result.protected, 0);
  assert.equal(calls[0].body.target_lang, 'ZH-HANS');
  assert.equal(calls[0].body.segments, undefined);
});

await test('型号正则：GPT-5 / V4.1 / M3.1 命中，整名由词表命中', async () => {
  assert.deepEqual(modelTokens('GPT-5').map((m) => m.term), ['GPT-5']);
  assert.deepEqual(modelTokens('V4.1').map((m) => m.term), ['V4.1']);
  assert.deepEqual(modelTokens('M3.1').map((m) => m.term), ['M3.1']);
  assert.deepEqual(modelTokens('A4'), [], '单字母+数字不应命中');

  const compiled = compileGlossary(['DeepSeek V4.1 Flash']);
  const terms = matchTerms('DeepSeek V4.1 Flash', compiled).map((m) => m.term);
  assert.deepEqual(terms, ['DeepSeek V4.1 Flash']);
});

await test('40 条上限：prompt 与校验都只用前 40 条', async () => {
  const terms = Array.from({ length: 45 }, (_, i) => `Term${String(i + 1).padStart(2, '0')}`);
  const source = terms.join(' ');
  // 只保留前 40 个：如果校验用了完整词表，这里会因为缺 Term41–45 被判失败
  const kept = terms.slice(0, 40).join(' ');

  /** @type {Call[]} */
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: '', body, headers: init.headers });
    return new Response(chatResult([kept]), { status: 200 });
  };

  const result = await translateBatch({
    texts: [source],
    config: chatConfig,
    target: '中文',
    targetCode: 'ZH',
    glossary: terms,
    enforcement: 'fallback',
  });

  const system = systemOf(calls[0].body);
  assert.match(system, /Term01/);
  assert.match(system, /Term40/);
  assert.doesNotMatch(system, /Term41/);
  assert.equal(result.protected, 0, '未注入 prompt 的词不参与校验');
  assert.deepEqual(result.translations, [kept]);
});

/* ------------------------------ 设置迁移 ------------------------------ */

await test('migrateSettings：旧 type 迁移、ZH 升级、幂等', async () => {
  const old = {
    targetLang: '文言文',
    targetLangCode: 'ZH',
    activeProviderId: 'p1',
    providers: [
      { id: 'p1', type: 'openai', baseUrl: 'https://api.test/v1', model: 'm', apiKey: 'k' },
      { id: 'p2', type: 'deepl', baseUrl: 'https://api-free.deepl.com', apiKey: 'd' },
    ],
  };

  const first = migrateSettings(old);
  assert.equal(first.changed, true);
  assert.equal(first.settings.schemaVersion, 2);
  assert.equal(first.settings.targetLang, '文言文', '老用户的自定义语言不能丢');
  assert.equal(first.settings.targetLangCode, 'ZH-HANS');
  assert.equal(first.settings.displayMode, 'translation');
  assert.equal(first.settings.enforcement, 'repair');
  assert.deepEqual(first.settings.glossary, { useBuiltin: true, terms: [] });

  const openai = first.settings.providers[0];
  assert.equal(openai.protocol, 'openai-chat');
  assert.equal(openai.presetId, 'custom');
  assert.equal(openai.type, undefined);
  assert.equal(openai.apiKey, 'k');

  const deepl = first.settings.providers[1];
  assert.equal(deepl.protocol, 'deepl');
  assert.equal(deepl.presetId, 'deepl');
  assert.equal(deepl.type, undefined);

  const second = migrateSettings(first.settings);
  assert.equal(second.changed, false, '重复迁移必须无变化');
  assert.deepEqual(second.settings, first.settings);
});

await test('normalizeSettings：范围与审校默认值、非法值回退', async () => {
  const empty = normalizeSettings({});
  assert.equal(empty.translateScope, 'viewport');
  assert.equal(empty.reviewProviderId, null);

  const kept = normalizeSettings({ translateScope: 'whole', reviewProviderId: 'p2' });
  assert.equal(kept.translateScope, 'whole');
  assert.equal(kept.reviewProviderId, 'p2');

  const bad = normalizeSettings({ translateScope: 'everything', reviewProviderId: 42 });
  assert.equal(bad.translateScope, 'viewport');
  assert.equal(bad.reviewProviderId, null);
});

/* ------------------------------ 微软翻译 ------------------------------ */

const edgeConfig = {
  id: 'edge',
  presetId: 'microsoft-edge',
  protocol: 'microsoft-edge',
  baseUrl: 'https://edge.microsoft.com',
};

const azureConfig = {
  id: 'azure',
  presetId: 'microsoft-azure',
  protocol: 'microsoft-azure',
  baseUrl: 'https://api.cognitive.microsofttranslator.com',
  apiKey: 'azure-key',
  region: 'eastasia',
};

/** @param {any[]} texts @returns {string} */
const microsoftResult = (texts) =>
  JSON.stringify(texts.map((text) => ({ translations: [{ text: `译:${text}` }] })));

await test('microsoft-edge：无鉴权头、body 是字符串数组、语言码用 zh-Hans', async () => {
  /** @type {Call[]} */
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    return new Response(microsoftResult(body), { status: 200 });
  };

  const out = await translateBatch({
    texts: ['a', 'b'],
    config: edgeConfig,
    target: '简体中文',
    targetCode: 'ZH-HANS',
  });

  assert.deepEqual(out.translations, ['译:a', '译:b']);
  assert.match(calls[0].url, /^https:\/\/edge\.microsoft\.com\/translate\/translatetext\?/);
  assert.match(calls[0].url, /to=zh-Hans/);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].headers['Ocp-Apim-Subscription-Key'], undefined);
  assert.deepEqual(calls[0].body, ['a', 'b']);
});

await test('microsoft-azure：key/region 头、Text 数组、api-version 与语言码', async () => {
  /** @type {Call[]} */
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    return new Response(microsoftResult(body.map((item) => item.Text)), { status: 200 });
  };

  const out = await translateBatch({
    texts: ['a'],
    config: azureConfig,
    target: '简体中文',
    targetCode: 'ZH-HANS',
  });

  assert.deepEqual(out.translations, ['译:a']);
  assert.match(calls[0].url, /api-version=3\.0/);
  assert.match(calls[0].url, /to=zh-Hans/);
  assert.equal(calls[0].headers['Ocp-Apim-Subscription-Key'], 'azure-key');
  assert.equal(calls[0].headers['Ocp-Apim-Subscription-Region'], 'eastasia');
  assert.deepEqual(calls[0].body, [{ Text: 'a' }]);
});

await test('微软翻译：术语层跳过（不注入、不校验、不回退）', async () => {
  /** @type {Call[]} */
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push({ url: '', body: JSON.parse(init.body), headers: init.headers });
    return new Response(microsoftResult(['没有保留术语']), { status: 200 });
  };

  const result = await translateBatch({
    texts: ['Kubernetes 简介'],
    config: edgeConfig,
    target: '简体中文',
    targetCode: 'ZH-HANS',
    glossary: ['Kubernetes'],
    enforcement: 'fallback',
  });

  assert.deepEqual(result.translations, ['译:没有保留术语']);
  assert.equal(result.protected, 0);
  assert.equal(result.warnings.length, 0);
});

await test('microsoftCode：10 种语言映射，老值原样返回', async () => {
  assert.equal(microsoftCode('ZH-HANS'), 'zh-Hans');
  assert.equal(microsoftCode('ZH-HANT'), 'zh-Hant');
  assert.equal(microsoftCode('EN-US'), 'en');
  assert.equal(microsoftCode('PT-BR'), 'pt');
  assert.equal(microsoftCode('简体中文'), 'zh-Hans');
  assert.equal(microsoftCode('Klingon'), 'Klingon');
  assert.equal(microsoftCode(''), 'en');
});

/* ------------------------------ 审校规则 ------------------------------ */

const noGlossary = compileGlossary([]);

await test('review 规则：术语 / 空译 / 同原文 / 长度 / 脚本', async () => {
  const term = findSuspicious({
    sources: ['Kubernetes 简介'],
    translations: ['简介'],
    compiled: compileGlossary(['Kubernetes']),
    targetCode: 'ZH-HANS',
  });
  assert.equal(term.items.length, 1);
  assert.ok(term.items[0].reasons.includes('term'));
  assert.deepEqual(term.items[0].missing, ['Kubernetes']);

  const empty = findSuspicious({
    sources: ['hello world'],
    translations: [''],
    compiled: noGlossary,
    targetCode: 'ZH-HANS',
  });
  assert.ok(empty.items[0].reasons.includes('empty'));

  const same = findSuspicious({
    sources: ['hello world'],
    translations: ['hello world'],
    compiled: noGlossary,
    targetCode: 'ZH-HANS',
  });
  assert.ok(same.items[0].reasons.includes('same'));

  const short = findSuspicious({
    sources: ['a'.repeat(100)],
    translations: ['短'],
    compiled: noGlossary,
    targetCode: 'ZH-HANS',
  });
  assert.ok(short.items[0].reasons.includes('length'));

  const wrongScript = findSuspicious({
    sources: ['hello world'],
    translations: ['hello world translated'],
    compiled: noGlossary,
    targetCode: 'ZH-HANS',
  });
  assert.ok(wrongScript.items[0].reasons.includes('script'));
});

await test('review 规则：数字 / URL / 占位符 / 相邻重复', async () => {
  const numbers = findSuspicious({
    sources: ['There are 3 ports and 2 hosts'],
    translations: ['使用端口和主机'],
    compiled: noGlossary,
    targetCode: 'ZH-HANS',
  });
  assert.ok(numbers.items[0].reasons.includes('numbers'));

  const url = findSuspicious({
    sources: ['See https://example.test/docs for details'],
    translations: ['详见文档'],
    compiled: noGlossary,
    targetCode: 'ZH-HANS',
  });
  assert.ok(url.items[0].reasons.includes('url'));

  const placeholder = findSuspicious({
    sources: ['Hello ${name}, welcome to {{site}}'],
    translations: ['欢迎'],
    compiled: noGlossary,
    targetCode: 'ZH-HANS',
  });
  assert.ok(placeholder.items[0].reasons.includes('placeholder'));

  const duplicate = findSuspicious({
    sources: ['First paragraph', 'Second paragraph'],
    translations: ['相同译文', '相同译文'],
    compiled: noGlossary,
    targetCode: 'ZH-HANS',
  });
  assert.equal(duplicate.items.length, 1, '只标记后一项');
  assert.equal(duplicate.items[0].index, 1);
  assert.ok(duplicate.items[0].reasons.includes('duplicate'));
});

await test('review 上限：最多 200 段，超出标记 truncated', async () => {
  const sources = Array.from({ length: REVIEW_MAX_SEGMENTS + 5 }, (_, i) => `source ${i}`);
  const translations = sources.map(() => '');
  const found = findSuspicious({
    sources,
    translations,
    compiled: noGlossary,
    targetCode: 'EN-US',
  });
  assert.equal(found.items.length, REVIEW_MAX_SEGMENTS);
  assert.equal(found.truncated, true);
});

/* ------------------------------ 审校请求 ------------------------------ */

await test('review：修正可疑段，按顺序对齐并保留术语', async () => {
  /** @type {Call[]} */
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: '', body, headers: init.headers });
    const payload = JSON.parse(body.messages[1].content);
    assert.equal(payload.segments.length, 1);
    assert.equal(payload.segments[0].source, 'Kubernetes 简介');
    return new Response(chatResult(['Kubernetes 简介']), { status: 200 });
  };

  const result = await reviewTranslations({
    sources: ['Kubernetes 简介'],
    translations: ['简介'],
    config: chatConfig,
    target: '简体中文',
    targetCode: 'ZH-HANS',
    glossary: ['Kubernetes'],
  });

  assert.equal(result.review.failed, false);
  assert.equal(result.review.reviewed, 1);
  assert.equal(result.review.corrected, 1);
  assert.deepEqual(result.translations, ['Kubernetes 简介']);
  assert.match(calls[0].body.messages[0].content, /JSON/);
  assert.match(calls[0].body.messages[0].content, /审校/);
});

await test('review：空修正、无术语时同原文、仍漏术语的条目都丢弃', async () => {
  const termArgs = {
    sources: ['Kubernetes 简介'],
    translations: ['简介'],
    config: chatConfig,
    target: '简体中文',
    targetCode: 'ZH-HANS',
    glossary: ['Kubernetes'],
  };

  globalThis.fetch = async () => new Response(chatResult(['']), { status: 200 });
  const empty = await reviewTranslations(termArgs);
  assert.equal(empty.review.corrected, 0);
  assert.deepEqual(empty.translations, ['简介']);

  // 没有术语缺失时，把译文“修正”成原文等于没翻
  globalThis.fetch = async () => new Response(chatResult(['Hello there']), { status: 200 });
  const sameAsSource = await reviewTranslations({
    sources: ['Hello there'],
    translations: ['你好'],
    config: chatConfig,
    target: '简体中文',
    targetCode: 'ZH-HANS',
    glossary: [],
  });
  assert.equal(sameAsSource.review.corrected, 0);
  assert.deepEqual(sameAsSource.translations, ['你好']);

  globalThis.fetch = async () => new Response(chatResult(['仍然没有术语']), { status: 200 });
  const stillMissing = await reviewTranslations(termArgs);
  assert.equal(stillMissing.review.corrected, 0);
  assert.deepEqual(stillMissing.translations, ['简介']);
});

await test('review：请求失败或数量不符时保留主译文并标记 failed', async () => {
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  const failed = await reviewTranslations({
    sources: ['Kubernetes 简介'],
    translations: ['简介'],
    config: chatConfig,
    target: '简体中文',
    targetCode: 'ZH-HANS',
    glossary: ['Kubernetes'],
  });
  assert.equal(failed.review.failed, true);
  assert.deepEqual(failed.translations, ['简介']);

  globalThis.fetch = async () => new Response(chatResult([]), { status: 200 });
  const mismatch = await reviewTranslations({
    sources: ['Kubernetes 简介'],
    translations: ['简介'],
    config: chatConfig,
    target: '简体中文',
    targetCode: 'ZH-HANS',
    glossary: ['Kubernetes'],
  });
  assert.equal(mismatch.review.failed, true);
  assert.deepEqual(mismatch.translations, ['简介']);
});

await test('review：审校服务配成 MT 时直接失败，不发请求', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  };
  const result = await reviewTranslations({
    sources: ['Kubernetes 简介'],
    translations: ['简介'],
    config: chatDeeplConfig,
    target: '简体中文',
    targetCode: 'ZH-HANS',
    glossary: ['Kubernetes'],
  });
  assert.equal(result.review.failed, true);
  assert.equal(calls, 0);
  assert.deepEqual(result.translations, ['简介']);
});

if (failures > 0) {
  console.log(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
