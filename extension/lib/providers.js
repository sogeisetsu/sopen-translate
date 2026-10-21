/**
 * 翻译服务适配层。
 *
 * 每个 provider 实现：
 *   type        唯一标识
 *   label       设置页显示名
 *   hint        设置页说明
 *   fields      设置页要渲染的字段 [{ key, label, placeholder, secret, required }]
 *   translate({ texts, config, target, targetCode, signal }) -> string[]
 *
 * 约定：输入 n 条文本，必须返回 n 条，顺序一致。数量对不上直接报错，
 * 宁可失败也不要把翻译错位写回页面。
 */

class ProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderError';
  }
}

function fail(message) {
  throw new ProviderError(message);
}

function trimSlash(url = '') {
  return String(url).trim().replace(/\/+$/, '');
}

function clip(text = '', max = 240) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function postJson(url, { headers, body, signal }) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err?.name === 'AbortError') fail('请求已取消');
    fail(`无法连接 ${url}：${err?.message || err}`);
  }
  const raw = await res.text();
  if (!res.ok) fail(`HTTP ${res.status}：${clip(raw) || res.statusText}`);
  try {
    return JSON.parse(raw);
  } catch {
    fail(`响应不是合法 JSON：${clip(raw)}`);
  }
}

/* ------------------------------ OpenAI 兼容 ------------------------------ */

const SYSTEM_PROMPT = (target) =>
  `你是翻译引擎。用户会给你一个 JSON 对象 {"segments": [...]}，请把 segments 里每一项逐条翻译成${target}。` +
  `要求：返回的数组长度、顺序与原数组完全一致；不合并、不拆分、不省略、不添加解释；` +
  `每一段只输出译文本身，不要保留原文。只返回 JSON 对象 {"segments": [...]}，不要代码块。`;

/** 从模型返回里抠出数组，兼容 ```json 包裹和多余前后缀 */
function parseSegments(content, expected) {
  if (!content) fail('模型返回为空');

  const candidates = [];
  candidates.push(content);

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);

  const first = content.indexOf('{');
  const last = content.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(content.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate.trim());
      const arr = Array.isArray(data) ? data : data?.segments;
      if (Array.isArray(arr)) return arr.map((item) => String(item ?? ''));
    } catch {
      /* 换下一个候选 */
    }
  }
  fail(`无法解析模型返回：${clip(content)}`);
}

const openai = {
  type: 'openai',
  label: 'OpenAI 兼容接口',
  hint: '适用于 OpenAI、DeepSeek、Moonshot、One-API、Ollama 等提供 /chat/completions 的服务。',
  fields: [
    { key: 'baseUrl', label: '接口地址', placeholder: 'https://api.openai.com/v1', required: true },
    { key: 'model', label: '模型', placeholder: 'gpt-4o-mini', required: true },
    { key: 'apiKey', label: 'API Key', placeholder: 'sk-...', secret: true },
  ],
  async translate({ texts, config, target, signal }) {
    const endpoint = `${trimSlash(config.baseUrl)}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    const base = {
      model: config.model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT(target) },
        { role: 'user', content: JSON.stringify({ segments: texts }) },
      ],
    };

    let data;
    try {
      // 优先要求 JSON 输出；部分兼容实现不认这个参数，失败一次再去掉重试
      data = await postJson(endpoint, {
        headers,
        body: { ...base, response_format: { type: 'json_object' } },
        signal,
      });
    } catch (err) {
      if (!/HTTP 4\d\d/.test(err.message)) throw err;
      data = await postJson(endpoint, { headers, body: base, signal });
    }

    const segments = parseSegments(data?.choices?.[0]?.message?.content, texts.length);
    if (segments.length !== texts.length) {
      fail(`返回分段数不符：期望 ${texts.length}，实际 ${segments.length}`);
    }
    return segments;
  },
};

/* --------------------------------- DeepL --------------------------------- */

const deepl = {
  type: 'deepl',
  label: 'DeepL',
  hint: '免费版密钥用 https://api-free.deepl.com，付费版用 https://api.deepl.com。',
  fields: [
    { key: 'baseUrl', label: '接口地址', placeholder: 'https://api-free.deepl.com', required: true },
    { key: 'apiKey', label: 'API Key', placeholder: ':fx 结尾的密钥', secret: true, required: true },
  ],
  async translate({ texts, config, targetCode, signal }) {
    const endpoint = `${trimSlash(config.baseUrl)}/v2/translate`;
    const data = await postJson(endpoint, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DeepL-Auth-Key ${config.apiKey}`,
      },
      body: { text: texts, target_lang: targetCode || 'ZH' },
      signal,
    });

    const list = data?.translations;
    if (!Array.isArray(list)) fail(`响应缺少 translations：${clip(JSON.stringify(data))}`);
    if (list.length !== texts.length) {
      fail(`返回分段数不符：期望 ${texts.length}，实际 ${list.length}`);
    }
    return list.map((item) => String(item?.text ?? ''));
  },
};

/* -------------------------------- 注册表 -------------------------------- */

export const PROVIDER_TYPES = [openai, deepl];

export function getProviderType(type) {
  const found = PROVIDER_TYPES.find((p) => p.type === type);
  if (!found) fail(`未知的翻译服务类型：${type}`);
  return found;
}

export { ProviderError };
