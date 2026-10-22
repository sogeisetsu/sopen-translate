/**
 * 内置翻译服务预设（纯数据，不 import 任何东西）。
 *
 * `models` 是“拿不到列表时的兜底建议”，允许过期；用户点“刷新”后以接口返回为准。
 * `verified` 只表示“用真 key 端到端跑过”，`false` 的卡片必须在设置页标注“接口未实测”。
 *
 * @typedef {Object} ProviderPreset
 * @property {string} id
 * @property {string} label
 * @property {import('../../types').ProtocolId} protocol
 * @property {string} baseUrl
 * @property {string} [modelsUrl]     与 baseUrl 不同时单独给出（OpenCode Go 就是这种）
 * @property {string[]} models
 * @property {boolean} supportsModelList
 * @property {boolean} [requiresSession] 请求必须带 x-opencode-session
 * @property {boolean} verified
 * @property {string} [hint]
 */

/** @type {ProviderPreset[]} */
export const PROVIDER_PRESETS = [
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    protocol: 'openai-chat',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    modelsUrl: 'https://opencode.ai/inference/go/v1/models',
    models: [
      'deepseek-v4.1-flash',
      'deepseek-v4-pro',
      'glm-5.3',
      'glm-5.3-flash',
      'kimi-k3',
      'gpt-5.6-luna',
    ],
    supportsModelList: true,
    requiresSession: true,
    verified: true,
    hint: '需要 API Key；扩展会自动生成并带上 x-opencode-session。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-luna'],
    supportsModelList: true,
    verified: false,
    hint: '接口未实测；baseUrl/模型名以官方文档为准。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    supportsModelList: true,
    verified: false,
    hint: '接口未实测；baseUrl/模型名以官方文档为准。',
  },
  {
    id: 'sensenova',
    label: '商汤 SenseNova',
    protocol: 'openai-chat',
    baseUrl: 'https://token.sensenova.cn/v1',
    models: ['sensenova-6.8-flash-lite', 'deepseek-v4.1-flash'],
    supportsModelList: true,
    verified: true,
    hint: 'RPM 较低；扩展会自动退避重试。',
  },
  {
    id: 'kimi',
    label: 'Kimi（中国站）',
    protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3', 'kimi-k2.6'],
    supportsModelList: true,
    verified: false,
    hint: '接口未实测；baseUrl/模型名以官方文档为准。',
  },
  {
    id: 'kimi-global',
    label: 'Kimi（国际站）',
    protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k3'],
    supportsModelList: true,
    verified: false,
    hint: '接口未实测；baseUrl/模型名以官方文档为准。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    protocol: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2'],
    supportsModelList: true,
    verified: false,
    hint: '接口未实测；baseUrl/模型名以官方文档为准。',
  },
  {
    id: 'dashscope',
    label: '阿里百炼',
    protocol: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-flash', 'qwen-flash', 'qwen3.5-plus'],
    supportsModelList: true,
    verified: false,
    hint: '接口未实测；baseUrl/模型名以官方文档为准。',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'openai-chat',
    baseUrl: 'https://api.minimax.io/v1',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    supportsModelList: true,
    verified: false,
    hint: '国际站用 api.minimax.io；中国站可能需要 api.minimaxi.com，未实测。',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openrouter/auto', 'openai/gpt-5.2'],
    supportsModelList: true,
    verified: false,
    hint: '接口未实测；baseUrl/模型名以官方文档为准。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    protocol: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V4-Flash', 'moonshotai/Kimi-K2.6'],
    supportsModelList: true,
    verified: false,
    hint: '接口未实测；baseUrl/模型名以官方文档为准。',
  },
  {
    id: 'deepl',
    label: 'DeepL',
    protocol: 'deepl',
    baseUrl: 'https://api-free.deepl.com',
    models: [],
    supportsModelList: false,
    verified: true,
    hint: '不支持术语保护；免费版用 api-free，付费版用 api.deepl.com。',
  },
  {
    id: 'custom',
    label: '自定义',
    protocol: 'openai-chat',
    baseUrl: '',
    models: [],
    supportsModelList: true,
    verified: false,
    hint: 'OpenAI 兼容接口；本地 Ollama / One-API 可以不填 API Key。',
  },
];

/** @type {Record<string, ProviderPreset>} */
export const PRESET_BY_ID = Object.fromEntries(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

/**
 * 未知 id 一律回落到 `custom`，避免设置页因为一条坏数据整页崩掉。
 * @param {string | undefined} id
 * @returns {ProviderPreset}
 */
export function getPreset(id) {
  return PRESET_BY_ID[String(id ?? '')] || PRESET_BY_ID.custom;
}
