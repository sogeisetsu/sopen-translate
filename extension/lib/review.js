/**
 * 审校层（纯函数）：先用确定性规则筛出可疑段，再把「原文 + 主译文 + 原因」
 * 交给第二个 LLM 定点修正。不联网、不读 `chrome.*`。
 *
 * 设计取舍：
 * - 只筛可疑段，绝不把整页重发一遍（全量审校会把 LLM 吞吐瓶颈请回来）；
 * - 修正结果按**顺序**对齐回可疑段，不依赖模型返回的 index：
 *   模型改号 / 漏项时顺序对齐比信任 index 更安全；
 * - 任何校验不过的修正都丢弃，保留主译文。
 *
 * @typedef {import('../../types').ReviewItem} ReviewItem
 */

import { verifySegment } from './glossary.js';

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
 * 确定性筛可疑段。只返回有理由的项。
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
  /** @type {ReviewItem[]} */
  const items = [];
  let chars = 0;
  let truncated = false;

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

    const cost = source.length + translated.length;
    if (items.length >= maxSegments || chars + cost > maxChars) {
      truncated = true;
      continue;
    }
    chars += cost;
    items.push({ index, reasons, missing: [...new Set(missing)] });
  }

  return { items, truncated };
}

/**
 * 审校 system prompt。必须保留 "JSON" 字样：
 * `deepseek-v4.1-flash` 的 `response_format` 会检查 prompt 里是否出现 json。
 * @param {string} target
 * @returns {string}
 */
export function buildReviewSystemPrompt(target) {
  return [
    `你是翻译审校器。目标语言是「${target}」。`,
    '输入是 JSON：segments 是待检查片段数组，每项含 index / source / primary / reasons / missing。',
    '逐项检查 primary 译文：',
    '- 只修正确实有问题的译文；没有问题就原样返回 primary，不要润色、不要改语气。',
    '- 必须保留 source 中的专有名词、品牌名、型号、代码、URL、数字和占位符。',
    '- 不要合并、拆分、增删片段。',
    '只输出 JSON：{"segments":["修正后的译文", "..."]}。',
    '数组长度必须与输入完全一致、顺序不变，每项都是字符串；不要输出 index，不要解释。',
  ].join('\n');
}

/**
 * @param {Object} args
 * @param {string} args.target
 * @param {ReviewItem[]} args.items
 * @param {string[]} args.sources
 * @param {string[]} args.translations
 * @returns {{ system: string, userContent: string }}
 */
export function buildReviewRequest({ target, items, sources, translations }) {
  const segments = items.map((item) => ({
    index: item.index,
    source: sources[item.index] ?? '',
    primary: translations[item.index] ?? '',
    reasons: item.reasons,
    missing: item.missing,
  }));
  return {
    system: buildReviewSystemPrompt(target),
    userContent: JSON.stringify({ segments }),
  };
}

/**
 * 把模型返回的修正按顺序套回可疑段；任何校验不过的条目丢弃。
 * @param {Object} args
 * @param {string[]} args.sources
 * @param {string[]} args.translations
 * @param {ReviewItem[]} args.items
 * @param {string[]} args.corrected
 * @param {ReturnType<typeof import('./glossary.js').compileGlossary>} args.compiled
 * @returns {{ translations: string[], corrected: number }}
 */
export function applyReviewCorrections({ sources, translations, items, corrected, compiled }) {
  const next = translations.slice();
  if (corrected.length !== items.length) return { translations: next, corrected: 0 };

  let count = 0;
  items.forEach((item, position) => {
    const text = String(corrected[position] ?? '').trim();
    if (!text) return;

    const source = String(sources[item.index] ?? '');
    const primary = String(translations[item.index] ?? '').trim();
    if (text === primary) return;
    // 没有术语缺失时，“修正”成原文等于没翻；有术语缺失时保留原文是合法的保护手段
    if (text === source.trim() && item.missing.length === 0) return;
    // 修正不能丢掉原文里的数字 / URL / 占位符
    if (countNumbers(text) !== countNumbers(source)) return;
    if (countUrls(text) !== countUrls(source)) return;
    if (countPlaceholders(text) !== countPlaceholders(source)) return;
    // 仍然漏术语的“修正”没有价值，丢弃
    if (item.missing.length > 0) {
      const verdict = verifySegment({ source, translated: text, compiled, allowed: compiled.terms });
      if (!verdict.ok) return;
    }

    next[item.index] = text;
    count += 1;
  });

  return { translations: next, corrected: count };
}
