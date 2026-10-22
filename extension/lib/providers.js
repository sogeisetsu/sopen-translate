/**
 * 翻译服务适配层。
 *
 * 新代码只该用 `translateBatch()`：它在协议层之上加了「等长校验 + 术语注入 + 译后校验」。
 *
 * `getProviderType()` 是给旧调用方（老配置、旧测试）的兼容入口，不要在新代码里依赖
 * `PROVIDER_TYPES` / `type.fields`。约定始终不变：输入 n 条文本，必须原序返回 n 条，
 * 数量对不上直接报错——宁可失败，也不要把译文错位写回页面。
 *
 * @typedef {import('../../types').ProviderType} ProviderType
 * @typedef {import('../../types').ProviderConfig} ProviderConfig
 * @typedef {import('../../types').TranslateArgs} TranslateArgs
 * @typedef {import('../../types').TranslateBatchResult} TranslateBatchResult
 * @typedef {import('../../types').Protocol} Protocol
 */

import { ProviderError, fail } from './http.js';
import { getProtocol } from './protocols.js';
import { compileGlossary, matchTerms, promptTerms, verifySegment } from './glossary.js';

/**
 * @param {string[]} translations
 * @param {number} expected
 */
function assertLength(translations, expected) {
  if (translations.length !== expected) {
    fail(`返回分段数不符：期望 ${expected}，实际 ${translations.length}`);
  }
}

/**
 * 去重一份「术语 + 位置」列表里的术语，保持首次出现顺序。
 * @param {{ term: string }[]} matches
 * @returns {string[]}
 */
function uniqueTerms(matches) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const match of matches) {
    const key = match.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match.term);
  }
  return out;
}

/**
 * 哪些错误值得“拆小重试”：输出被截断或 JSON 坏掉。
 * HTTP 401/429 之类不该拆，拆了只会放大请求。
 * @param {unknown} err
 * @returns {boolean}
 */
function isSplittableError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return /分段数不符|无法解析模型返回|模型返回为空|响应不是合法 JSON/.test(message);
}

/**
 * @param {TranslateArgs} args
 * @returns {Promise<TranslateBatchResult>}
 */
async function splitBatch(args) {
  const mid = Math.ceil(args.texts.length / 2);
  const left = await runBatch({ ...args, texts: args.texts.slice(0, mid) }, true);
  const right = await runBatch({ ...args, texts: args.texts.slice(mid) }, true);
  return {
    translations: [...left.translations, ...right.translations],
    protected: left.protected + right.protected,
    warnings: [
      ...left.warnings,
      ...right.warnings.map((warning) => ({ ...warning, index: warning.index + mid })),
    ],
  };
}

/**
 * @param {TranslateArgs} args
 * @returns {Promise<TranslateBatchResult>}
 */
export async function translateBatch(args) {
  return runBatch(args, true);
}

/**
 * 输出被截断（分段数不符 / JSON 解析失败）时自动二分重试。
 * 不同模型的输出上限不同，客户端不写死 4096。
 * @param {TranslateArgs} args
 * @param {boolean} allowSplit
 * @returns {Promise<TranslateBatchResult>}
 */
async function runBatch(args, allowSplit) {
  const {
    texts,
    config,
    target,
    targetCode,
    glossary = [],
    enforcement = 'repair',
    extraHeaders,
    retry,
  } = args;
  const protocol = getProtocol(config.protocol);

  // DeepL 没有 prompt 通道：完全跳过术语层，不注入、不校验、不回退。
  if (protocol.id === 'deepl') {
    const translations = await protocol.translate({
      texts,
      config,
      target,
      targetCode,
      terms: [],
      extraHeaders,
      retry,
    });
    assertLength(translations, texts.length);
    return { translations, protected: 0, warnings: [] };
  }

  const compiled = compileGlossary(Array.isArray(glossary) ? glossary : []);
  const matches = texts.map((text) => matchTerms(text, compiled));
  const termsForPrompt = promptTerms(matches.flat(), 40);
  const allowed = new Set(termsForPrompt.map((term) => term.toLowerCase()));

  /** @type {string[]} */
  let translations;
  try {
    translations = await protocol.translate({
      texts,
      config,
      target,
      targetCode,
      terms: termsForPrompt,
      extraHeaders,
      retry,
    });
  } catch (err) {
    if (allowSplit && texts.length > 1 && isSplittableError(err)) return splitBatch(args);
    throw err;
  }

  if (translations.length !== texts.length) {
    if (allowSplit && texts.length > 1) return splitBatch(args);
    assertLength(translations, texts.length);
  }

  /** @type {{ index: number, missing: string[] }[]} */
  const failures = [];
  texts.forEach((source, index) => {
    const verdict = verifySegment({ source, translated: translations[index], compiled, allowed });
    if (!verdict.ok) failures.push({ index, missing: verdict.missing });
  });

  /** @type {TranslateBatchResult['warnings']} */
  const warnings = [];
  let protectedCount = 0;

  /** @param {number} index */
  const fallbackToSource = (index) => {
    translations[index] = texts[index];
    protectedCount += 1;
  };

  if (enforcement === 'fallback') {
    for (const failure of failures) fallbackToSource(failure.index);
  } else if (enforcement === 'warn') {
    for (const failure of failures) {
      warnings.push({ index: failure.index, missing: failure.missing });
      console.debug('[sopen-translate] 术语可能未保留', failure.index, failure.missing);
    }
  } else if (failures.length > 0) {
    // repair：只重发漏词的段，最多一次；第二次仍缺就回退原文。
    const subset = failures.map((failure) => texts[failure.index]);
    const repairTerms = uniqueTerms(failures.flatMap((failure) => failure.missing.map((term) => ({ term }))));
    const repairAllowed = new Set(repairTerms.map((term) => term.toLowerCase()));

    /** @type {string[] | null} */
    let repaired = null;
    try {
      repaired = await protocol.translate({
        texts: subset,
        config,
        target,
        targetCode,
        terms: repairTerms,
        extraHeaders,
        retry,
        repair: true,
      });
    } catch {
      repaired = null;
    }

    if (!repaired || repaired.length !== subset.length) {
      for (const failure of failures) fallbackToSource(failure.index);
    } else {
      failures.forEach((failure, position) => {
        const verdict = verifySegment({
          source: texts[failure.index],
          translated: repaired?.[position],
          compiled,
          allowed: repairAllowed,
        });
        if (verdict.ok && repaired) translations[failure.index] = repaired[position];
        else fallbackToSource(failure.index);
      });
    }
  }

  return { translations, protected: protectedCount, warnings };
}

/* --------------------------- 旧调用方兼容入口 --------------------------- */

/** @type {ProviderType} */
const legacyOpenai = {
  type: 'openai',
  label: 'OpenAI 兼容接口',
  hint: '适用于 OpenAI、DeepSeek、Moonshot、One-API、Ollama 等提供 /chat/completions 的服务。',
  fields: [
    { key: 'baseUrl', label: '接口地址', placeholder: 'https://api.openai.com/v1', required: true },
    { key: 'model', label: '模型', placeholder: 'gpt-4o-mini', required: true },
    { key: 'apiKey', label: 'API Key', placeholder: 'sk-...', secret: true },
  ],
  async translate(args) {
    /** @type {ProviderConfig} */
    const config = { ...args.config, protocol: 'openai-chat' };
    const result = await translateBatch({
      ...args,
      config,
      glossary: [],
      enforcement: 'warn',
    });
    return result.translations;
  },
};

/** @type {ProviderType} */
const legacyDeepl = {
  type: 'deepl',
  label: 'DeepL',
  hint: '免费版密钥用 https://api-free.deepl.com，付费版用 https://api.deepl.com。',
  fields: [
    { key: 'baseUrl', label: '接口地址', placeholder: 'https://api-free.deepl.com', required: true },
    { key: 'apiKey', label: 'API Key', placeholder: ':fx 结尾的密钥', secret: true, required: true },
  ],
  async translate(args) {
    /** @type {ProviderConfig} */
    const config = { ...args.config, protocol: 'deepl' };
    const result = await translateBatch({
      ...args,
      config,
      glossary: [],
      enforcement: 'warn',
    });
    return result.translations;
  },
};

/** @type {ProviderType[]} */
export const PROVIDER_TYPES = [legacyOpenai, legacyDeepl];

/**
 * `openai` / `deepl` 返回旧适配对象；五个协议 id 直接返回协议实现。
 * @param {string} id
 * @returns {ProviderType | Protocol}
 */
export function getProviderType(id) {
  const legacy = PROVIDER_TYPES.find((provider) => provider.type === id);
  if (legacy) return legacy;
  if (id === 'openai-chat' || id === 'openai-responses' || id === 'anthropic-messages' || id === 'google-gemini' || id === 'deepl') {
    return getProtocol(id);
  }
  fail(`未知的翻译服务类型：${id}`);
}

export { ProviderError };
