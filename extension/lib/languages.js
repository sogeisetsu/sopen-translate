/**
 * 目标语言的唯一来源：popup 与设置页都读写这份列表，避免两处各写一套后漂移。
 *
 * - `name` 给大模型 prompt 用；
 * - `code` 给 DeepL 这类需要语言代码的服务用；
 * - `ms` 给微软翻译（Edge / Azure）用，两者共用同一套语言码；
 * - `google` 给 Google 免费网页接口用。
 *
 * @typedef {{ id: string, name: string, code: string, ms: string, google: string }} Language
 */

/** @type {Language[]} */
export const LANGUAGES = [
  { id: 'zh-Hans', name: '简体中文', code: 'ZH-HANS', ms: 'zh-Hans', google: 'zh-CN' },
  { id: 'zh-Hant', name: '繁体中文', code: 'ZH-HANT', ms: 'zh-Hant', google: 'zh-TW' },
  { id: 'ja', name: '日语', code: 'JA', ms: 'ja', google: 'ja' },
  { id: 'ko', name: '韩语', code: 'KO', ms: 'ko', google: 'ko' },
  { id: 'en', name: '英语', code: 'EN-US', ms: 'en', google: 'en' },
  { id: 'fr', name: '法语', code: 'FR', ms: 'fr', google: 'fr' },
  { id: 'de', name: '德语', code: 'DE', ms: 'de', google: 'de' },
  { id: 'es', name: '西班牙语', code: 'ES', ms: 'es', google: 'es' },
  { id: 'ru', name: '俄语', code: 'RU', ms: 'ru', google: 'ru' },
  { id: 'pt', name: '葡萄牙语', code: 'PT-BR', ms: 'pt', google: 'pt' },
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

/**
 * 微软翻译语言码：`ZH-HANS → zh-Hans`、`EN-US → en`。
 * 列表外的老值原样返回（迁移只处理 `ZH`，其余保持用户原意）。
 * @param {string | undefined | null} nameOrCode
 * @returns {string}
 */
export function microsoftCode(nameOrCode) {
  const language = findLanguage(nameOrCode);
  if (language) return language.ms;
  const raw = String(nameOrCode ?? '').trim();
  return raw || 'en';
}

/**
 * Google 免费网页接口语言码：`ZH-HANS → zh-CN`、`ZH-HANT → zh-TW`。
 * 列表外的老值原样返回。
 * @param {string | undefined | null} nameOrCode
 * @returns {string}
 */
export function googleCode(nameOrCode) {
  const language = findLanguage(nameOrCode);
  if (language) return language.google;
  const raw = String(nameOrCode ?? '').trim();
  return raw || 'en';
}
