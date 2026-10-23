/**
 * 协议层：每种协议只负责「URL / 鉴权 / 请求体 / 响应解析」。
 *
 * 这里不知道任何厂商；术语校验、429 重试、分段数校验都在上游
 * （`providers.js` 与 `http.js`）。`extraHeaders` 只由 background 注入。
 *
 * @typedef {import('../../types').Protocol} Protocol
 * @typedef {import('../../types').ProtocolBuildArgs} ProtocolBuildArgs
 * @typedef {import('../../types').ProtocolId} ProtocolId
 */

import { ProviderError, clip, fail, joinUrl, postJson } from './http.js';
import { parseSegments } from './segments.js';
import { reasoningOffParams } from './reasoning.js';
import { buildRepairSystemPrompt, buildSystemPrompt, buildUserPayload } from './prompt.js';
import { microsoftCode } from './languages.js';

/** 已经证明不支持思考开关的配置（preset|baseUrl|model），避免每批都 400 一次 */
const reasoningUnsupported = new Set();

/**
 * @param {{ presetId?: string, baseUrl?: string, model?: string }} config
 * @returns {string}
 */
function reasoningKey(config) {
  return `${config.presetId || ''}|${config.baseUrl || ''}|${config.model || ''}`;
}

/**
 * @param {Record<string, string> | undefined} extraHeaders
 * @returns {Record<string, string>}
 */
function jsonHeaders(extraHeaders) {
  return { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
}

/**
 * Bearer 鉴权；OpenCode Go 这类额外的头从 extraHeaders 合进来。
 * @param {ProtocolBuildArgs} args
 * @returns {Record<string, string>}
 */
function llmHeaders(args) {
  /** @type {Record<string, string>} */
  const headers = jsonHeaders(args.extraHeaders);
  if (args.config.apiKey) headers.Authorization = `Bearer ${args.config.apiKey}`;
  return headers;
}

/** @param {ProtocolBuildArgs} args @returns {string} */
function systemFor(args) {
  if (args.system) return args.system;
  const terms = args.terms || [];
  return args.repair ? buildRepairSystemPrompt(args.target, terms) : buildSystemPrompt(args.target, terms);
}

/**
 * 默认是 `{segments:[...]}`；审校层用 `system` + `userContent` 覆盖，
 * 这样不必为审校再复制一套协议实现。
 * @param {ProtocolBuildArgs} args
 * @returns {string}
 */
function userFor(args) {
  return args.userContent ?? buildUserPayload(args.texts);
}

/**
 * 只有“参数不被支持”才去掉 response_format 重发。
 * 401/403/429 一律上抛，避免和退避重试叠加成 4+4 次请求。
 * @param {unknown} err
 * @returns {boolean}
 */
function isJsonModeRejection(err) {
  if (!(err instanceof ProviderError)) return false;
  return err.status === 400 || err.status === 404 || err.status === 422;
}

/* ------------------------------ openai-chat ------------------------------ */

/** @type {Protocol} */
const openaiChat = {
  id: 'openai-chat',
  label: 'OpenAI Chat Completions',
  buildRequest(args) {
    const url = joinUrl(args.config.baseUrl, '/chat/completions');
    const headers = llmHeaders(args);
    /** @type {Record<string, any>} */
    const body = {
      model: args.config.model,
      temperature: 0,
      messages: [
        { role: 'system', content: systemFor(args) },
        { role: 'user', content: userFor(args) },
      ],
    };
    // 翻译不需要思考；只对支持的模型发字段，强制思考的模型直接不发
    const reasoning = reasoningOffParams(args.config.presetId, args.config.model);
    if (reasoning && !reasoningUnsupported.has(reasoningKey(args.config))) {
      Object.assign(body, reasoning);
    }
    return { url, headers, body };
  },
  parseResponse(json) {
    return parseSegments(json?.choices?.[0]?.message?.content);
  },
  async translate(args) {
    const request = openaiChat.buildRequest(args);
    const body = /** @type {Record<string, any>} */ (request.body);
    const retryDelays = args.retry?.delays;
    const reasoning = reasoningOffParams(args.config.presetId, args.config.model);
    const reasoningApplied = reasoning
      ? Object.keys(reasoning).some((field) => field in body)
      : false;

    try {
      const data = await postJson(request.url, {
        headers: request.headers,
        body: { ...body, response_format: { type: 'json_object' } },
        retryDelays,
      });
      return openaiChat.parseResponse(data);
    } catch (err) {
      if (!isJsonModeRejection(err)) throw err;

      // 先只去掉思考字段，尽量保留 response_format
      if (reasoningApplied && reasoning) {
        reasoningUnsupported.add(reasoningKey(args.config));
        const withoutReasoning = { ...body };
        for (const field of Object.keys(reasoning)) delete withoutReasoning[field];
        try {
          const data = await postJson(request.url, {
            headers: request.headers,
            body: { ...withoutReasoning, response_format: { type: 'json_object' } },
            retryDelays,
          });
          return openaiChat.parseResponse(data);
        } catch (err2) {
          if (!isJsonModeRejection(err2)) throw err2;
          const data = await postJson(request.url, {
            headers: request.headers,
            body: withoutReasoning,
            retryDelays,
          });
          return openaiChat.parseResponse(data);
        }
      }

      // 没有思考字段：只回退 response_format
      const data = await postJson(request.url, {
        headers: request.headers,
        body,
        retryDelays,
      });
      return openaiChat.parseResponse(data);
    }
  },
};

/* ---------------------------- openai-responses ---------------------------- */

/** @type {Protocol} */
const openaiResponses = {
  id: 'openai-responses',
  label: 'OpenAI Responses',
  buildRequest(args) {
    const url = joinUrl(args.config.baseUrl, '/responses');
    const body = {
      model: args.config.model,
      temperature: 0,
      input: [
        { role: 'system', content: systemFor(args) },
        { role: 'user', content: userFor(args) },
      ],
    };
    return { url, headers: llmHeaders(args), body };
  },
  parseResponse(json) {
    const output = Array.isArray(json?.output) ? json.output : [];
    const text = output
      .flatMap((/** @type {any} */ item) => (Array.isArray(item?.content) ? item.content : []))
      .map((/** @type {any} */ part) => String(part?.text ?? ''))
      .join('');
    return parseSegments(text);
  },
  async translate(args) {
    const request = openaiResponses.buildRequest(args);
    const data = await postJson(request.url, {
      headers: request.headers,
      body: request.body,
      retryDelays: args.retry?.delays,
    });
    return openaiResponses.parseResponse(data);
  },
};

/* --------------------------- anthropic-messages --------------------------- */

/** @type {Protocol} */
const anthropicMessages = {
  id: 'anthropic-messages',
  label: 'Anthropic Messages',
  buildRequest(args) {
    const url = joinUrl(args.config.baseUrl, '/messages');
    /** @type {Record<string, string>} */
    const headers = jsonHeaders(args.extraHeaders);
    if (args.config.apiKey) headers['x-api-key'] = args.config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    const body = {
      model: args.config.model,
      max_tokens: 4096,
      temperature: 0,
      system: systemFor(args),
      messages: [{ role: 'user', content: userFor(args) }],
    };
    return { url, headers, body };
  },
  parseResponse(json) {
    const content = Array.isArray(json?.content) ? json.content : [];
    return parseSegments(content.map((/** @type {any} */ part) => String(part?.text ?? '')).join(''));
  },
  async translate(args) {
    const request = anthropicMessages.buildRequest(args);
    const data = await postJson(request.url, {
      headers: request.headers,
      body: request.body,
      retryDelays: args.retry?.delays,
    });
    return anthropicMessages.parseResponse(data);
  },
};

/* ----------------------------- google-gemini ----------------------------- */

/** @type {Protocol} */
const googleGemini = {
  id: 'google-gemini',
  label: 'Google Gemini',
  buildRequest(args) {
    const model = String(args.config.model ?? '').trim();
    const base = joinUrl(args.config.baseUrl, `/models/${encodeURIComponent(model)}:generateContent`);
    const key = String(args.config.apiKey ?? '');
    const url = key ? `${base}?key=${encodeURIComponent(key)}` : base;
    const body = {
      systemInstruction: { parts: [{ text: systemFor(args) }] },
      contents: [{ role: 'user', parts: [{ text: userFor(args) }] }],
      generationConfig: { temperature: 0 },
    };
    return { url, headers: jsonHeaders(args.extraHeaders), body };
  },
  parseResponse(json) {
    const parts = json?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
      ? parts.map((/** @type {any} */ part) => String(part?.text ?? '')).join('')
      : '';
    return parseSegments(text);
  },
  async translate(args) {
    const request = googleGemini.buildRequest(args);
    const data = await postJson(request.url, {
      headers: request.headers,
      body: request.body,
      retryDelays: args.retry?.delays,
    });
    return googleGemini.parseResponse(data);
  },
};

/* ----------------------------- Microsoft MT ----------------------------- */

/**
 * Edge / Azure 的响应同形：`[{ translations: [{ text }] }]`，按输入顺序取第一条译文。
 * @param {any} json
 * @returns {string[]}
 */
function parseMicrosoft(json) {
  if (!Array.isArray(json)) fail(`响应缺少 translations 数组：${clip(JSON.stringify(json))}`);
  return json.map((item) => String(item?.translations?.[0]?.text ?? ''));
}

/**
 * Edge 内置翻译的内部免费接口：没有 key / region / Authorization。
 * 无 SLA，可能限流或改路径；失败时用户可切到 Azure 或自定义。
 * @type {Protocol}
 */
const microsoftEdge = {
  id: 'microsoft-edge',
  label: 'Microsoft Edge 翻译（无需 key）',
  supportsGlossary: false,
  buildRequest(args) {
    const base = args.config.baseUrl || 'https://edge.microsoft.com';
    const to = microsoftCode(args.targetCode || args.target);
    const url = `${joinUrl(base, '/translate/translatetext')}?from=&to=${encodeURIComponent(
      to,
    )}&isEnterpriseClient=false`;
    return {
      url,
      // 内部接口只认这几个头；不要混入 Authorization
      headers: { 'Content-Type': 'application/json' },
      body: args.texts,
    };
  },
  parseResponse(json) {
    return parseMicrosoft(json);
  },
  async translate(args) {
    const request = microsoftEdge.buildRequest(args);
    const data = await postJson(request.url, {
      headers: request.headers,
      body: request.body,
      timeoutMs: 30000,
      retryDelays: args.retry?.delays,
    });
    return microsoftEdge.parseResponse(data);
  },
};

/**
 * Azure Translator 官方接口：key 必填；区域资源还要 `Ocp-Apim-Subscription-Region`。
 * @type {Protocol}
 */
const microsoftAzure = {
  id: 'microsoft-azure',
  label: 'Microsoft Azure Translator',
  supportsGlossary: false,
  buildRequest(args) {
    const base = args.config.baseUrl || 'https://api.cognitive.microsofttranslator.com';
    const to = microsoftCode(args.targetCode || args.target);
    const url = `${joinUrl(base, '/translate')}?api-version=3.0&to=${encodeURIComponent(to)}`;
    /** @type {Record<string, string>} */
    const headers = jsonHeaders(args.extraHeaders);
    if (args.config.apiKey) headers['Ocp-Apim-Subscription-Key'] = args.config.apiKey;
    if (args.config.region) headers['Ocp-Apim-Subscription-Region'] = args.config.region;
    return {
      url,
      headers,
      body: args.texts.map((text) => ({ Text: text })),
    };
  },
  parseResponse(json) {
    return parseMicrosoft(json);
  },
  async translate(args) {
    const request = microsoftAzure.buildRequest(args);
    const data = await postJson(request.url, {
      headers: request.headers,
      body: request.body,
      timeoutMs: 30000,
      retryDelays: args.retry?.delays,
    });
    return microsoftAzure.parseResponse(data);
  },
};

/* --------------------------------- DeepL --------------------------------- */

/** @type {Protocol} */
const deepl = {
  id: 'deepl',
  label: 'DeepL',
  supportsGlossary: false,
  buildRequest(args) {
    const url = joinUrl(args.config.baseUrl, '/v2/translate');
    return {
      url,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DeepL-Auth-Key ${args.config.apiKey ?? ''}`,
      },
      body: { text: args.texts, target_lang: args.targetCode || 'ZH' },
    };
  },
  parseResponse(json) {
    const list = json?.translations;
    if (!Array.isArray(list)) fail(`响应缺少 translations：${clip(JSON.stringify(json))}`);
    return list.map((/** @type {any} */ item) => String(item?.text ?? ''));
  },
  async translate(args) {
    const request = deepl.buildRequest(args);
    const data = await postJson(request.url, {
      headers: request.headers,
      body: request.body,
      retryDelays: args.retry?.delays,
    });
    return deepl.parseResponse(data);
  },
};

/* -------------------------------- 注册表 -------------------------------- */

/** @type {Record<string, Protocol>} */
export const PROTOCOLS = {
  'openai-chat': openaiChat,
  'openai-responses': openaiResponses,
  'anthropic-messages': anthropicMessages,
  'google-gemini': googleGemini,
  'microsoft-edge': microsoftEdge,
  'microsoft-azure': microsoftAzure,
  deepl,
};

/**
 * @param {string} id
 * @returns {Protocol}
 */
export function getProtocol(id) {
  const protocol = PROTOCOLS[id];
  if (!protocol) fail(`未知的翻译协议：${id}`);
  return protocol;
}

/** 设置页「协议」下拉用 */
export const PROTOCOL_OPTIONS = Object.values(PROTOCOLS).map((protocol) => ({
  id: protocol.id,
  label: protocol.label,
}));
