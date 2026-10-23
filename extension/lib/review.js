/**
 * 审校层（纯函数）：先用确定性规则筛出可疑段，再把「原文 + 主译文 + 原因」
 * 交给第二个 LLM 定点修正。不联网、不读 `chrome.*`。
 *
 * 设计取舍：
 * - 只筛可疑段，绝不把整页重发一遍（全量审校会把 LLM 吞吐瓶颈请回来）；
 * - 可疑段按“严重度”排序后再吃预算：预算不够时先保住空译 / 同原文 / 漏术语，
 *   而不是页面最前面几条无关紧要的长度异常；
 * - 修正结果按校验通过与否过滤，任何一项校验不过都丢弃，保留主译文。
 *
 * @typedef {import('../../types').ReviewItem} ReviewItem
 * @typedef {import('../../types').ReviewCorrection} ReviewCorrection
 * @typedef {import('../../types').ReviewOutcome} ReviewOutcome
 */

import { verifySegment } from './glossary.js';
import { parseJsonPayload } from './segments.js';

/** 每页最多送审的段数与源文字符数（超出只取前面的，交给调用方标记 truncated） */
export const REVIEW_MAX_SEGMENTS = 200;
export const REVIEW_MAX_CHARS = 8000;

/** @type {Record<string, 'han' | 'japanese' | 'hangul' | 'cyrillic' | 'latin'>} */
const SCRIPT_BY_CODE = {
  'ZH-HANS': 'han',
  'ZH-HANT': 'han',
  JA: 'japanese',
  KO: 'hangul',
  RU: 'cyrillic',
  'EN-US': 'latin',
  EN: 'latin',
  FR: 'latin',
  DE: 'latin',
  ES: 'latin',
  PT: 'latin',
  'PT-BR': 'latin',
};

/**
 * @param {string | undefined | null} targetCode
 * @returns {'han' | 'japanese' | 'hangul' | 'cyrillic' | 'latin' | null}
 */
export function targetScript(targetCode) {
  return SCRIPT_BY_CODE[String(targetCode ?? '').trim().toUpperCase()] || null;
}

/** @param {'han' | 'japanese' | 'hangul' | 'cyrillic' | 'latin'} script */
function hasScript(text, script) {
  switch (script) {
    case 'han':
      return /[\u3400-\u9fff]/.test(text);
    case 'japanese':
      return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
    case 'hangul':
      return /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(text);
    case 'cyrillic':
      return /[\u0400-\u04ff]/.test(text);
    case 'latin':
      return /\p{Script=Latin}/u.test(text);
    default:
      return true;
  }
}

/** @param {string} text */
function countNumbers(text) {
  return (text.match(/\d+(?:[.,]\d+)*/g) || []).length;
}

/** @param {string} text */
function countUrls(text) {
  return (text.match(/https?:\/\/[^\s)）\]】"'，。]+/g) || []).length;
}

/** @param {string} text */
function countPlaceholders(text) {
  return (
    text.match(/\{\{[^{}]*\}\}|\$\{[^{}]*\}|%\{\w+\}|%[0-9]+\$[sd]|%[sd]|\{[A-Za-z_][\w.]*\}/g) ||
    []
  ).length;
}

/**
 * 目标语言是 CJK 时，字符密度更高，长度比阈值要放宽。
 * @param {string | null} script
 * @returns {{ min: number, max: number }}
 */
function lengthRange(script) {
  return script === 'han' || script === 'japanese' || script === 'hangul'
    ? { min: 0.15, max: 4 }
    : { min: 0.3, max: 3 };
}

/**
 * 修正后的长度比校验要更宽松：允许多加几个字解释，但不接受整段增删。
 * @param {string | null} script
 * @returns {{ min: number, max: number }}
 */
function looseLengthRange(script) {
  return script === 'han' || script === 'japanese' || script === 'hangul'
    ? { min: 0.08, max: 6 }
    : { min: 0.2, max: 5 };
}

/** 规则严重度：预算不够时先审“一定读不通”的段 */
const REASON_SEVERITY = {
  empty: 100,
  same: 90,
  term: 80,
  numbers: 60,
  url: 60,
  placeholder: 60,
  script: 50,
  length: 30,
  duplicate: 20,
};

/**
 * 一条可疑段的严重度（取最高权重）。
 * @param {string[]} reasons
 * @returns {number}
 */
export function severityOf(reasons) {
  let score = 0;
  for (const reason of reasons) {
    const weight = REASON_SEVERITY[reason] ?? 10;
    if (weight > score) score = weight;
  }
  return score;
}

/** @param {string} text @returns {number} 原文里的 HTML 标签数（修正不能增删标签） */
function countHtmlTags(text) {
  return (String(text ?? '').match(/<[a-zA-Z][^>]*>/g) || []).length;
}

/**
 * 页面类型：只用于给审校模型一句语境，不参与校验。
 * @param {string | undefined | null} url
 * @returns {'wiki' | 'forum' | 'docs' | 'web'}
 */
export function pageKind(url) {
  const raw = String(url ?? '').toLowerCase();
  if (!raw) return 'web';
  if (/wikipedia\.org|wiki\/|wiki\./.test(raw)) return 'wiki';
  if (/forum|discourse|stackexchange|stackoverflow|reddit\.com|\/thread|\/t\//.test(raw)) {
    return 'forum';
  }
  if (/\/docs?\/|readthedocs|developer\.|doc\.|\/manual|\/reference|github\.com\/[^/]+\/[^/]+\/(blob|tree)/.test(raw)) {
    return 'docs';
  }
  return 'web';
}

/**
 * 只把域名发给模型：完整 URL 可能带 query（含 key），而且没必要。
 * @param {string | undefined | null} url
 * @returns {string}
 */
export function hostOf(url) {
  try {
    return new URL(String(url ?? '')).host;
  } catch {
    return '';
  }
}

/**
 * 确定性筛可疑段。只返回有理由的项。
 * 超出预算时按严重度优先保留，输出再按文档顺序排，方便日志对照。
 * @param {Object} args
 * @param {string[]} args.sources
 * @param {string[]} args.translations
 * @param {ReturnType<typeof import('./glossary.js').compileGlossary>} args.compiled
 * @param {string} [args.targetCode]
 * @param {number} [args.maxSegments]
 * @param {number} [args.maxChars]
 * @returns {{ items: ReviewItem[], truncated: boolean }}
 */
export function findSuspicious({
  sources,
  translations,
  compiled,
  targetCode = '',
  maxSegments = REVIEW_MAX_SEGMENTS,
  maxChars = REVIEW_MAX_CHARS,
}) {
  const script = targetScript(targetCode);
  const range = lengthRange(script);
  /** @type {{ index: number, reasons: string[], missing: string[], cost: number }[]} */
  const candidates = [];

  const total = Math.max(sources.length, translations.length);
  for (let index = 0; index < total; index += 1) {
    const source = String(sources[index] ?? '');
    const translated = String(translations[index] ?? '');
    if (!source.trim()) continue;

    /** @type {string[]} */
    const reasons = [];
    /** @type {string[]} */
    const missing = [];

    const verdict = verifySegment({ source, translated, compiled, allowed: compiled.terms });
    if (!verdict.ok) {
      reasons.push('term');
      missing.push(...verdict.missing);
    }

    if (!translated.trim()) {
      reasons.push('empty');
    } else if (translated.trim() === source.trim()) {
      reasons.push('same');
    }

    if (translated.trim() && source.trim().length > 0) {
      const ratio = translated.trim().length / source.trim().length;
      if (ratio < range.min) reasons.push('length');
      else if (ratio > range.max) reasons.push('length');
    }

    if (script && translated.trim() && /[\p{L}]/u.test(translated) && !hasScript(translated, script)) {
      reasons.push('script');
    }

    if (countNumbers(translated) !== countNumbers(source)) reasons.push('numbers');
    if (countUrls(translated) !== countUrls(source)) reasons.push('url');
    if (countPlaceholders(translated) !== countPlaceholders(source)) reasons.push('placeholder');

    if (
      index > 0 &&
      translated.trim() &&
      translated.trim() === String(translations[index - 1] ?? '').trim() &&
      source.trim() !== String(sources[index - 1] ?? '').trim()
    ) {
      reasons.push('duplicate');
    }

    if (reasons.length === 0) continue;

    candidates.push({
      index,
      reasons,
      missing: [...new Set(missing)],
      cost: source.length + translated.length,
    });
  }

  candidates.sort(
    (left, right) =>
      severityOf(right.reasons) - severityOf(left.reasons) || left.index - right.index,
  );

  /** @type {ReviewItem[]} */
  const items = [];
  let chars = 0;
  let truncated = false;
  for (const candidate of candidates) {
    if (items.length >= maxSegments || chars + candidate.cost > maxChars) {
      truncated = true;
      continue;
    }
    chars += candidate.cost;
    items.push({ index: candidate.index, reasons: candidate.reasons, missing: candidate.missing });
  }

  items.sort((left, right) => left.index - right.index);
  return { items, truncated };
}

/**
 * 按页预算裁剪送审项。预算是「原文 + 主译文」字符数，避免一大段把整页预算吃光。
 * 超出预算的条目不送审，由调用方把 truncated 标记带回 content。
 * @param {import('../../types').ReviewRunItem[]} items
 * @param {{ maxSegments?: number, maxChars?: number }} [limits]
 * @returns {{ items: import('../../types').ReviewRunItem[], truncated: boolean }}
 */
export function selectReviewItems(
  items,
  { maxSegments = REVIEW_MAX_SEGMENTS, maxChars = REVIEW_MAX_CHARS } = {},
) {
  /** @type {import('../../types').ReviewRunItem[]} */
  const picked = [];
  let chars = 0;
  let truncated = false;
  for (const item of items) {
    const cost = String(item.source ?? '').length + String(item.primary ?? '').length;
    if (picked.length >= maxSegments || chars + cost > maxChars) {
      truncated = true;
      continue;
    }
    chars += cost;
    picked.push(item);
  }
  return { items: picked, truncated };
}

/**
 * 审校 system prompt。必须保留 "JSON" 字样：
 * `deepseek-v4.1-flash` 的 `response_format` 会检查 prompt 里是否出现 json。
 * @param {string} target
 * @param {{ title?: string, host?: string, kind?: string }} [page]
 * @returns {string}
 */
export function buildReviewSystemPrompt(target, page = {}) {
  const contextLine =
    page.title || page.host || page.kind
      ? `语境：页面标题「${page.title || '未知'}」，域名 ${page.host || '未知'}，页面类型 ${
          page.kind || 'web'
        }。语境只用于判断术语和语气，不要翻译它。`
      : '';
  return [
    `你是翻译审校器。目标语言是「${target}」。`,
    contextLine,
    '输入是 JSON：segments 是待检查片段数组，每项含 index / source / primary / reasons / missing；可选的 prev / next 是相邻段，仅供理解语境。',
    '逐项检查 primary 译文：',
    '- 只修正确实有问题的译文；没有问题就跳过，不要润色、不要改语气。',
    '- 必须保留 source 中的专有名词、品牌名、型号、代码、URL、数字和占位符。',
    '- 保留 source 里的 HTML 标签数量与位置，不要合并、拆分、增删片段。',
    '只输出 JSON：{"segments":[{"index":3,"corrected":"修正后的译文"}]}。',
    '- 只返回需要修正的片段，index 必须与输入中的 index 一致；corrected 必须是字符串且非空。',
    '- 不要输出解释，不要返回没有问题的片段。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {Object} args
 * @param {string} args.target
 * @param {import('../../types').ReviewRunItem[]} args.items
 * @param {{ title?: string, host?: string, kind?: string }} [args.context]
 * @returns {{ system: string, userContent: string }}
 */
export function buildReviewRequest({ target, items, context }) {
  /** @type {{ title?: string, host?: string, kind?: string }} */
  const page = {};
  if (context?.title) page.title = String(context.title).slice(0, 120);
  if (context?.host) page.host = context.host;
  if (context?.kind) page.kind = context.kind;
  const hasPage = Object.keys(page).length > 0;

  const segments = items.map((item, index) => ({
    index,
    source: String(item.source ?? ''),
    primary: String(item.primary ?? ''),
    reasons: Array.isArray(item.reasons) ? item.reasons : [],
    missing: Array.isArray(item.missing) ? item.missing : [],
    ...(item.prev ? { prev: String(item.prev).slice(0, 200) } : {}),
    ...(item.next ? { next: String(item.next).slice(0, 200) } : {}),
  }));

  return {
    system: buildReviewSystemPrompt(target, page),
    userContent: JSON.stringify(hasPage ? { page, segments } : { segments }),
  };
}

/**
 * 解析审校响应：只接受 `{ segments: [{ index, corrected }] }`。
 * 非法条目（index 不是非负整数、corrected 不是字符串）直接丢弃；
 * 空 corrected 在套用阶段再丢弃。
 * @param {unknown} content
 * @returns {import('../../types').ReviewCorrection[]}
 */
export function parseReviewResponse(content) {
  const data = parseJsonPayload(content);
  const segments = data?.segments;
  if (!Array.isArray(segments)) return [];

  /** @type {import('../../types').ReviewCorrection[]} */
  const out = [];
  for (const item of segments) {
    const index = Number(item?.index);
    if (!Number.isInteger(index) || index < 0) continue;
    out.push({ index, corrected: String(item?.corrected ?? '') });
  }
  return out;
}

/**
 * 只替换 index 在可疑段集合内、corrected 非空且校验通过的条目。
 * 重复 index 只取第一次有效修正；被丢弃的条目带原因返回，供 diff 展示。
 * @param {Object} args
 * @param {string[]} args.sources
 * @param {string[]} args.translations
 * @param {ReviewItem[]} args.items
 * @param {ReviewCorrection[]} args.corrections
 * @param {ReturnType<typeof import('./glossary.js').compileGlossary>} args.compiled
 * @param {string} [args.targetCode]
 * @returns {{ translations: string[], corrected: number, rejected: { index: number, reason: string }[] }}
 */
export function applyReviewCorrections({
  sources,
  translations,
  items,
  corrections,
  compiled,
  targetCode = '',
}) {
  const next = translations.slice();
  const byIndex = new Map(items.map((item) => [item.index, item]));
  const seen = new Set();
  /** @type {{ index: number, reason: string }[]} */
  const rejected = [];
  const script = targetScript(targetCode);
  const range = looseLengthRange(script);
  let count = 0;

  for (const correction of corrections) {
    const item = byIndex.get(correction.index);
    if (!item) continue; // 不属于送审集合：静默丢弃
    if (seen.has(correction.index)) {
      rejected.push({ index: correction.index, reason: 'duplicate' });
      continue;
    }
    seen.add(correction.index);

    const text = String(correction.corrected ?? '').trim();
    if (!text) {
      rejected.push({ index: correction.index, reason: 'empty' });
      continue;
    }

    const source = String(sources[item.index] ?? '');
    const primary = String(translations[item.index] ?? '').trim();
    if (text === primary) {
      rejected.push({ index: correction.index, reason: 'same-primary' });
      continue;
    }
    // 没有术语缺失时，“修正”成原文等于没翻；有术语缺失时保留原文是合法的保护手段
    if (text === source.trim() && item.missing.length === 0) {
      rejected.push({ index: correction.index, reason: 'same-source' });
      continue;
    }
    // 修正不能丢掉原文里的数字 / URL / 占位符 / HTML 标签
    if (countNumbers(text) !== countNumbers(source)) {
      rejected.push({ index: correction.index, reason: 'numbers' });
      continue;
    }
    if (countUrls(text) !== countUrls(source)) {
      rejected.push({ index: correction.index, reason: 'url' });
      continue;
    }
    if (countPlaceholders(text) !== countPlaceholders(source)) {
      rejected.push({ index: correction.index, reason: 'placeholder' });
      continue;
    }
    if (countHtmlTags(text) !== countHtmlTags(source)) {
      rejected.push({ index: correction.index, reason: 'html' });
      continue;
    }
    // 目标脚本必须出现：中文目标语言却返回纯英文，不算修正
    if (script && /[\p{L}]/u.test(text) && !hasScript(text, script)) {
      rejected.push({ index: correction.index, reason: 'script' });
      continue;
    }
    // 长度比只要在宽松范围内就接受；超出说明整段被增删
    if (source.trim()) {
      const ratio = text.length / source.trim().length;
      if (ratio < range.min || ratio > range.max) {
        rejected.push({ index: correction.index, reason: 'length' });
        continue;
      }
    }
    // 仍然漏术语的“修正”没有价值，丢弃
    if (item.missing.length > 0) {
      const verdict = verifySegment({ source, translated: text, compiled, allowed: compiled.terms });
      if (!verdict.ok) {
        rejected.push({ index: correction.index, reason: 'term' });
        continue;
      }
    }

    next[item.index] = text;
    count += 1;
  }

  return { translations: next, corrected: count, rejected };
}
