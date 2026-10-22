/**
 * 目标语言的唯一来源：popup 与设置页都读写这份列表，避免两处各写一套后漂移。
 *
 * - `name` 给大模型 prompt 用；
 * - `code` 给 DeepL 这类需要语言代码的服务用。
 *
 * @typedef {{ id: string, name: string, code: string }} Language
 */

/** @type {Language[]} */
export const LANGUAGES = [
  { id: 'zh-Hans', name: '简体中文', code: 'ZH-HANS' },
  { id: 'zh-Hant', name: '繁体中文', code: 'ZH-HANT' },
  { id: 'ja', name: '日语', code: 'JA' },
  { id: 'ko', name: '韩语', code: 'KO' },
  { id: 'en', name: '英语', code: 'EN-US' },
  { id: 'fr', name: '法语', code: 'FR' },
  { id: 'de', name: '德语', code: 'DE' },
  { id: 'es', name: '西班牙语', code: 'ES' },
  { id: 'ru', name: '俄语', code: 'RU' },
  { id: 'pt', name: '葡萄牙语', code: 'PT-BR' },
];

/** 新装默认语言 */
export const DEFAULT_LANGUAGE = LANGUAGES[0];

/**
 * 按语言名称或语言代码查找；两者都不区分大小写。
 * @param {string | undefined | null} nameOrCode
 * @returns {Language | undefined}
 */
export function findLanguage(nameOrCode) {
  const wanted = String(nameOrCode ?? '').trim().toLowerCase();
  if (!wanted) return undefined;
  return LANGUAGES.find(
    (lang) => lang.name.toLowerCase() === wanted || lang.code.toLowerCase() === wanted,
  );
}
