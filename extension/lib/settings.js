/**
 * 设置读写。所有内容只存在 chrome.storage.local：
 * 密钥不上传、不进仓库、不写日志。
 *
 * @typedef {import('../../types').Settings} Settings
 * @typedef {import('../../types').ProviderConfig} ProviderConfig
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  /** 给大模型用的目标语言（自然语言描述） */
  targetLang: '简体中文',
  /** 给 DeepL 这类需要语言代码的服务用 */
  targetLangCode: 'ZH',
  /** 当前启用的 provider 实例 id */
  activeProviderId: null,
  /** provider 实例列表 */
  providers: [],
};

/** @returns {Promise<Settings>} */
export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  /** @type {Partial<Settings>} */
  const stored = settings || {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

/**
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** @returns {Promise<{ settings: Settings, provider: ProviderConfig | null }>} */
export async function getActiveProvider() {
  const settings = await getSettings();
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  return { settings, provider: provider || null };
}
