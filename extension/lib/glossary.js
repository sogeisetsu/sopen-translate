/**
 * 术语层（纯函数）：规范化、匹配、prompt 列表、译后校验。
 *
 * 不读 `chrome.*`、不联网；词库的加载与缓存在 `background.js`。
 *
 * @typedef {import('../../types').ProviderConfig} ProviderConfig
 * @typedef {{ term: string, index: number }} TermMatch
 * @typedef {Object} CompiledGlossary
 * @property {string[]} terms            规范化后的完整列表
 * @property {RegExp | null} asciiRe     单个 alternation，长词优先
 * @property {Map<string, string>} asciiCanonical  lower → 规范写法
 * @property {string[]} cjkTerms         按长度降序
 */

/** @type {Map<string, CompiledGlossary>} 只保留最近一条，避免长页面反复编译 */
let compileCache = new Map();

/**
 * trim、NBSP → 空格、压缩连续空白、去空、大小写不敏感去重（保留首次写法）。
 * @param {Iterable<string> | undefined | null} list
 * @returns {string[]}
 */
export function normalizeTerms(list) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const term = String(raw ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/** @param {string} text @returns {boolean} */
function isAsciiTerm(text) {
  return /^[\x20-\x7e]+$/.test(text);
}

/**
 * @param {string[]} terms
 * @returns {CompiledGlossary}
 */
export function compileGlossary(terms) {
  const normalized = normalizeTerms(terms);
  const cacheKey = normalized.join('\u0000');
  const cached = compileCache.get(cacheKey);
  if (cached) return cached;

  /** @type {Map<string, string>} */
  const asciiCanonical = new Map();
  /** @type {string[]} */
  const asciiTerms = [];
  /** @type {string[]} */
  const cjkTerms = [];

  for (const term of normalized) {
    if (isAsciiTerm(term)) {
      asciiCanonical.set(term.toLowerCase(), term);
      asciiTerms.push(term);
    } else {
      cjkTerms.push(term);
    }
  }

  asciiTerms.sort((a, b) => b.length - a.length);
  cjkTerms.sort((a, b) => b.length - a.length);

  /** @type {RegExp | null} */
  let asciiRe = null;
  if (asciiTerms.length > 0) {
    const alternation = asciiTerms
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    asciiRe = new RegExp(`(?<![A-Za-z0-9_.-])(?:${alternation})(?![A-Za-z0-9_.-])`, 'gi');
  }

  /** @type {CompiledGlossary} */
  const compiled = { terms: normalized, asciiRe, asciiCanonical, cjkTerms };
  compileCache = new Map([[cacheKey, compiled]]);
  return compiled;
}

/**
 * 型号正则（内置规则，不属于词表）。`V4` / `M3` 这种无小数点的短型号
 * 依赖 allowlist 里的全名，不要放宽到单字母+数字，否则 `A4`、`B5` 会误伤。
 * @param {string} text
 * @returns {TermMatch[]}
 */
export function modelTokens(text) {
  const source = String(text ?? '');
  /** @type {TermMatch[]} */
  const matches = [];
  const patterns = [
    /[A-Za-z][\w.]*\s?-?\s?v?\d+(?:\.\d+)+(?![\w.])/g,
    /\b[A-Z]{2,}[-\s]?\d+\b/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    /** @type {RegExpExecArray | null} */
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const term = match[0].trim();
      if (term) matches.push({ term, index: match.index });
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  return matches;
}

/**
 * @param {string} text
 * @param {CompiledGlossary} compiled
 * @returns {TermMatch[]}
 */
export function matchTerms(text, compiled) {
  const source = String(text ?? '');
  /** @type {TermMatch[]} */
  const found = [];

  if (compiled.asciiRe) {
    compiled.asciiRe.lastIndex = 0;
    /** @type {RegExpExecArray | null} */
    let match;
    while ((match = compiled.asciiRe.exec(source)) !== null) {
      const canonical = compiled.asciiCanonical.get(match[0].toLowerCase()) || match[0];
      found.push({ term: canonical, index: match.index });
      if (match.index === compiled.asciiRe.lastIndex) compiled.asciiRe.lastIndex += 1;
    }
  }

  for (const term of compiled.cjkTerms) {
    let from = 0;
    for (;;) {
      const index = source.indexOf(term, from);
      if (index === -1) break;
      found.push({ term, index });
      from = index + term.length;
    }
  }

  found.push(...modelTokens(source));

  // 按位置排序；重叠区间只保留更长的那个（长词优先）
  found.sort((a, b) => a.index - b.index || b.term.length - a.term.length);
  /** @type {TermMatch[]} */
  const kept = [];
  for (const match of found) {
    const last = kept[kept.length - 1];
    if (last) {
      if (last.index === match.index && last.term.toLowerCase() === match.term.toLowerCase()) continue;
      if (match.index < last.index + last.term.length) {
        if (match.term.length > last.term.length) kept[kept.length - 1] = match;
        continue;
      }
    }
    kept.push(match);
  }
  return kept;
}

/**
 * 按出现顺序去重、截断 40 条。校验也用这同一份列表。
 * @param {TermMatch[]} matches
 * @param {number} [max]
 * @returns {string[]}
 */
export function promptTerms(matches, max = 40) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const match of matches) {
    const key = match.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match.term);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 只校验「源文命中且已注入 prompt」的词。
 * @param {Object} args
 * @param {string} args.source
 * @param {string} args.translated
 * @param {CompiledGlossary} args.compiled
 * @param {Iterable<string>} args.allowed  本批 termsForPrompt（大小写不敏感）
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function verifySegment({ source, translated, compiled, allowed }) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  const allowedLower = new Set([...allowedSet].map((term) => String(term).toLowerCase()));

  /** @type {string[]} */
  const hit = [];
  for (const match of matchTerms(source, compiled)) {
    if (!allowedLower.has(match.term.toLowerCase())) continue;
    if (!hit.some((term) => term.toLowerCase() === match.term.toLowerCase())) hit.push(match.term);
  }
  if (hit.length === 0) return { ok: true, missing: [] };

  const rawTranslated = String(translated ?? '');
  if (!rawTranslated.trim()) return { ok: false, missing: hit };

  const translatedText = rawTranslated.replace(/\s+/g, ' ').replace(/\u00a0/g, ' ');
  const translatedLower = translatedText.toLowerCase();

  /** @type {string[]} */
  const missing = [];
  for (const term of hit) {
    const present = isAsciiTerm(term)
      ? translatedLower.includes(term.toLowerCase())
      : translatedText.includes(term);
    if (!present) missing.push(term);
  }
  return { ok: missing.length === 0, missing };
}
