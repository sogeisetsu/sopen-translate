/**
 * 设置读写。所有内容只存在 chrome.storage.local：
 * 密钥不上传、不进仓库、不写日志。
 *
 * 老版本（schemaVersion 缺失，provider 用 `type: 'openai' | 'deepl'`）的设置
 * 在读取时迁移；迁移函数是纯函数、幂等，重复执行不会有变化。
 *
 * @typedef {import('../../types').Settings} Settings
 * @typedef {import('../../types').ProviderConfig} ProviderConfig
 * @typedef {import('../../types').EnforcementMode} EnforcementMode
 * @typedef {import('../../types').DisplayMode} DisplayMode
 * @typedef {import('../../types').GlossarySettings} GlossarySettings
 */

import { DEFAULT_LANGUAGE } from './languages.js';
import { getPreset } from './provider-presets.js';

/** @type {GlossarySettings} */
const DEFAULT_GLOSSARY = { useBuiltin: true, terms: [] };

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  schemaVersion: 2,
  /** 给大模型用的目标语言（自然语言描述） */
  targetLang: DEFAULT_LANGUAGE.name,
  /** 给 DeepL 这类需要语言代码的服务用 */
  targetLangCode: DEFAULT_LANGUAGE.code,
  /** 当前启用的 provider 实例 id */
  activeProviderId: null,
  /** provider 实例列表 */
  providers: [],
  displayMode: 'translation',
  translateScope: 'viewport',
  enforcement: 'repair',
  glossary: DEFAULT_GLOSSARY,
  reviewProviderId: null,
  sessionId: '',
};

/**
 * 把存储里的任意形状补成字段齐全的 Settings（不迁移旧 `type` 字段）。
 * @param {any} stored
 * @returns {Settings}
 */
export function normalizeSettings(stored) {
  const raw = stored && typeof stored === 'object' ? stored : {};

  /** @type {ProviderConfig[]} */
  const providers = (Array.isArray(raw.providers) ? raw.providers : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const presetId =
        typeof item.presetId === 'string' && item.presetId
          ? item.presetId
          : item.type === 'deepl'
            ? 'deepl'
            : 'custom';
      /** @type {ProviderConfig} */
      const provider = {
        ...item,
        id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
        presetId,
        protocol: item.protocol || getPreset(presetId).protocol,
      };
      return provider;
    });

  const glossarySource = raw.glossary && typeof raw.glossary === 'object' ? raw.glossary : {};
  /** @type {GlossarySettings} */
  const glossary = {
    useBuiltin:
      typeof glossarySource.useBuiltin === 'boolean'
        ? glossarySource.useBuiltin
        : DEFAULT_GLOSSARY.useBuiltin,
    terms: Array.isArray(glossarySource.terms) ? glossarySource.terms.map((t) => String(t)) : [],
  };

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    schemaVersion: 2,
    activeProviderId:
      typeof raw.activeProviderId === 'string' ? raw.activeProviderId : DEFAULT_SETTINGS.activeProviderId,
    targetLang: String(raw.targetLang ?? DEFAULT_SETTINGS.targetLang),
    targetLangCode: String(raw.targetLangCode ?? DEFAULT_SETTINGS.targetLangCode),
    displayMode: raw.displayMode === 'bilingual' ? 'bilingual' : 'translation',
    translateScope: raw.translateScope === 'whole' ? 'whole' : 'viewport',
    enforcement: /** @type {EnforcementMode} */ (
      ['fallback', 'repair', 'warn'].includes(raw.enforcement)
        ? raw.enforcement
        : DEFAULT_SETTINGS.enforcement
    ),
    reviewProviderId:
      typeof raw.reviewProviderId === 'string' && raw.reviewProviderId
        ? raw.reviewProviderId
        : null,
    glossary,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    providers,
  };
}

/**
 * 迁移旧设置。**先**处理原始 `type`，再交给 normalizeSettings。
 * @param {any} stored
 * @returns {{ settings: Settings, changed: boolean }}
 */
export function migrateSettings(stored) {
  const raw = stored && typeof stored === 'object' ? stored : {};
  let changed = raw.schemaVersion !== 2;

  /** @type {any[]} */
  const providers = (Array.isArray(raw.providers) ? raw.providers : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const next = { ...item };
      if (next.type && !next.protocol) {
        if (next.type === 'deepl') {
          next.presetId = next.presetId || 'deepl';
          next.protocol = 'deepl';
        } else {
          next.presetId = next.presetId || 'custom';
          next.protocol = 'openai-chat';
        }
        changed = true;
      }
      if ('type' in next) {
        delete next.type;
        changed = true;
      }
      return next;
    });

  let targetLangCode = raw.targetLangCode;
  if (targetLangCode === 'ZH') {
    targetLangCode = 'ZH-HANS';
    changed = true;
  }

  const settings = normalizeSettings({
    ...raw,
    providers,
    ...(targetLangCode === undefined ? {} : { targetLangCode }),
  });

  return { settings, changed };
}

/** @returns {Promise<Settings>} */
export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const { settings: migrated, changed } = migrateSettings(settings);
  if (changed) await chrome.storage.local.set({ settings: migrated });
  return migrated;
}

/**
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function saveSettings(patch) {
  const current = await getSettings();
  /** @type {Settings} */
  const next = { ...current, ...patch };
  if (patch.glossary) {
    next.glossary = { ...current.glossary, ...patch.glossary };
  }
  await chrome.storage.local.set({ settings: next });
  return next;
}

/**
 * 每安装一个 UUID；为空时生成并落盘一次。
 * 不放进 getSettings()：否则任何一次读取都可能写盘。
 * @returns {Promise<string>}
 */
export async function getSessionId() {
  const settings = await getSettings();
  if (settings.sessionId) return settings.sessionId;
  const sessionId = crypto.randomUUID();
  await saveSettings({ sessionId });
  return sessionId;
}

/**
 * 只改一个 provider，避免用设置页的旧草稿覆盖其它字段。
 * @param {string} id
 * @param {Partial<ProviderConfig>} patch
 * @returns {Promise<ProviderConfig | null>}
 */
export async function patchProvider(id, patch) {
  const settings = await getSettings();
  const index = settings.providers.findIndex((provider) => provider.id === id);
  if (index === -1) return null;
  const providers = settings.providers.slice();
  providers[index] = { ...providers[index], ...patch };
  await saveSettings({ providers });
  return providers[index];
}

/**
 * 保存设置时保留后台刚刷新的模型缓存：存储里的更新就留下存储的。
 * @param {ProviderConfig[]} draft
 * @param {ProviderConfig[]} stored
 * @returns {ProviderConfig[]}
 */
export function mergeProviderCaches(draft, stored) {
  const storedById = new Map((stored || []).map((provider) => [provider.id, provider]));
  return (draft || []).map((provider) => {
    const saved = storedById.get(provider.id);
    const draftAt = provider.modelsCache?.at ?? 0;
    const storedAt = saved?.modelsCache?.at ?? 0;
    if (saved?.modelsCache && storedAt > draftAt) {
      return { ...provider, modelsCache: saved.modelsCache };
    }
    return provider;
  });
}

/** @returns {Promise<{ settings: Settings, provider: ProviderConfig | null }>} */
export async function getActiveProvider() {
  const settings = await getSettings();
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  return { settings, provider: provider || null };
}
