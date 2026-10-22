/**
 * 模型列表：URL 推导、响应解析、拉取与回退。
 *
 * background 只负责缓存与写盘；这里不碰 `chrome.*`，方便冒烟测试直接 stub fetch。
 *
 * @typedef {import('../../types').ProviderConfig} ProviderConfig
 * @typedef {import('./provider-presets.js').ProviderPreset} ProviderPreset
 */

import { getJson, joinUrl } from './http.js';
import { getPreset } from './provider-presets.js';

/**
 * 预设自带 modelsUrl 时优先用它，其次 `{baseUrl}/models`。
 * OpenCode Go 的 `{baseUrl}/models` 是 404，所以不能一把梭。
 * @param {ProviderConfig} config
 * @returns {string}
 */
export function resolveModelsUrl(config) {
  const preset = getPreset(config.presetId);
  if (config.modelsUrl) return config.modelsUrl;
  if (preset.modelsUrl && (!config.baseUrl || config.baseUrl === preset.baseUrl)) {
    return preset.modelsUrl;
  }
  return config.baseUrl ? joinUrl(config.baseUrl, '/models') : '';
}

/**
 * 容错 4 种形状，返回去重排序后的模型 id；认不出来就返回空数组。
 * 不做“猜哪些是聊天模型”的过滤——宁可让用户看到 embedding 模型并测试失败，
 * 也不要静默藏掉可用模型。
 * @param {any} json
 * @returns {string[]}
 */
export function parseModelList(json) {
  /** @type {any[]} */
  let items = [];
  if (Array.isArray(json)) items = json;
  else if (Array.isArray(json?.data)) items = json.data;
  else if (Array.isArray(json?.models)) items = json.models;

  /** @type {string[]} */
  const out = [];
  for (const item of items) {
    const value =
      typeof item === 'string' ? item : String(item?.id ?? item?.name ?? '');
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
  }
  return [...new Set(out)].sort();
}

/**
 * @param {{ url: string, apiKey?: string, timeoutMs?: number }} options
 * @returns {Promise<string[]>}
 */
export async function fetchModelList({ url, apiKey, timeoutMs = 8000 }) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const json = await getJson(url, { headers, timeoutMs });
  return parseModelList(json);
}

/**
 * 拉列表，失败/超时/空列表都安静地回退到预设建议（不抛错）。
 * @param {{ config: ProviderConfig, preset: ProviderPreset, timeoutMs?: number }} options
 * @returns {Promise<{ models: string[], from: 'network' | 'preset' }>}
 */
export async function loadModelList({ config, preset, timeoutMs = 8000 }) {
  const url = resolveModelsUrl(config);
  if (url) {
    try {
      const models = await fetchModelList({ url, apiKey: config.apiKey, timeoutMs });
      if (models.length > 0) return { models, from: 'network' };
    } catch {
      /* 回退预设，不打扰用户 */
    }
  }
  return { models: (preset.models || []).slice(), from: 'preset' };
}
