/**
 * 四套 LLM 协议共用的 prompt，避免在每个协议里复制一份。
 *
 * 注意：prompt 里必须保留 "JSON" 字样——`deepseek-v4.1-flash` 的
 * `response_format: json_object` 会检查 prompt 里是否出现这个词。
 *
 * @typedef {import('../../types').ProtocolBuildArgs} ProtocolBuildArgs
 */

const BASE_RULES =
  '要求：返回的数组长度、顺序与原数组完全一致；不合并、不拆分、不省略、不添加解释；' +
  '每一段只输出译文本身，不要保留原文。只返回 JSON 对象 {"segments": [...]}，不要代码块。';

/**
 * @param {string} target
 * @returns {string}
 */
function basePrompt(target) {
  return (
    `你是翻译引擎。用户会给你一个 JSON 对象 {"segments": [...]}，` +
    `请把 segments 里每一项逐条翻译成${target}。${BASE_RULES}`
  );
}

/**
 * 术语段落：只在本批真的命中术语时才追加。
 * @param {string[]} terms
 * @returns {string}
 */
function termsBlock(terms) {
  if (terms.length === 0) return '';
  return (
    '\n以下词是专有名词/品牌/技术名，必须原样出现在译文里：\n' +
    terms.map((term) => `- ${term}`).join('\n') +
    '\n不得翻译、不得音译、不得加括号注解。译文中若无法保留，对应段返回 null。\n' +
    '形如「品牌名 + 版本号」的字符串（如 GPT-5、DeepSeek V4.1 Flash）同样不得翻译。'
  );
}

/**
 * @param {string} target
 * @param {string[]} [terms]
 * @returns {string}
 */
export function buildSystemPrompt(target, terms = []) {
  return basePrompt(target) + termsBlock(terms);
}

/**
 * 修复轮：只重发上一轮漏词的段。
 * @param {string} target
 * @param {string[]} [terms]
 * @returns {string}
 */
export function buildRepairSystemPrompt(target, terms = []) {
  return (
    `你是翻译引擎。用户会给你一个 JSON 对象 {"segments": [...]}，` +
    `请把 segments 里每一项逐条翻译成${target}。` +
    '这是修复轮：上一轮遗漏了下面这些专有名词/品牌/技术名，必须原样出现在对应译文里：\n' +
    (terms.length ? terms.map((term) => `- ${term}`).join('\n') : '（见上一轮）') +
    '\n不得翻译、不得音译、不得加括号注解；形如「品牌名 + 版本号」的字符串同样不得翻译。' +
    '只返回 JSON 对象 {"segments": [...]}，长度必须与输入的 segments 一致，不要代码块。'
  );
}

/**
 * @param {string[]} texts
 * @returns {string}
 */
export function buildUserPayload(texts) {
  return JSON.stringify({ segments: texts });
}
