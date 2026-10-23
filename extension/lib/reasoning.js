/**
 * “翻译时关闭思考”的参数表。
 *
 * 纯数据 + 纯函数，不碰 chrome.*、不联网。各家网关的关闭方式并不统一，
 * 而且同一个预设下不同模型的规则也会冲突（例如 GLM-5.3 强制思考、
 * Kimi K3 强制思考、MiniMax-M3.1-Flash 强制思考），所以必须按模型判断：
 * 能关的发对应字段，不能关的直接不发，避免 400。
 *
 * 依据（2026-10-23）：
 * - OpenCode Go `deepseek-*`：`reasoning_effort: 'none'` 实测把 2903ms/114 思考 token
 *   降到 1285ms/0 思考 token；`glm-5.3*`、`kimi-k3` 强制思考。
 * - DeepSeek 官方：`thinking: { type: 'disabled' }`（默认 enabled）。
 * - Kimi：K2.6 支持 `thinking.type=disabled`；K3 始终思考。
 * - 智谱：GLM-5.2 支持 `thinking.type=disabled`；5.3 / 5.3-Flash 强制思考。
 * - 阿里百炼：`enable_thinking: false`（部分模型如 glm-5.3、kimi-k3 不可关）。
 * - MiniMax：M3 支持 `thinking.type=disabled`；M3.1-Flash 强制思考且传 disabled 会 400。
 * - OpenRouter：统一 `reasoning: { enabled: false }`；强制思考模型会拒绝。
 * - 硅基流动：`enable_thinking: false`（个别模型不认识该字段，靠 400 回退）。
 * - 商汤：实测 `reasoning_effort` / `thinking` / `enable_thinking` 均被忽略；
 *   仍发 `reasoning: { enabled: false }`，无效也无害。
 *
 * @typedef {{ preset: string, match: RegExp, params: Record<string, unknown> | null }} Rule
 */

/** @type {Rule[]} */
const RULES = [
  // --- OpenCode Go：聚合网关，按模型区分 ---
  { preset: 'opencode-go', match: /^deepseek/i, params: { reasoning_effort: 'none' } },
  { preset: 'opencode-go', match: /^gpt-5\.6/i, params: { reasoning_effort: 'none' } },
  { preset: 'opencode-go', match: /^glm-5\.3/i, params: null },
  { preset: 'opencode-go', match: /^kimi-k3/i, params: null },

  // --- OpenAI：5.1+ 支持 none；6.1-sol / 6-astra 不支持，靠 400 回退并记住 ---
  { preset: 'openai', match: /^gpt-5\.1/i, params: { reasoning_effort: 'none' } },
  { preset: 'openai', match: /^gpt-5\.6/i, params: { reasoning_effort: 'none' } },
  { preset: 'openai', match: /^gpt-6/i, params: { reasoning_effort: 'none' } },

  // --- DeepSeek 官方 ---
  { preset: 'deepseek', match: /.*/, params: { thinking: { type: 'disabled' } } },

  // --- Kimi：K3 强制思考，K2.5 / K2.6 可关 ---
  { preset: 'kimi', match: /^kimi-k3/i, params: null },
  { preset: 'kimi-global', match: /^kimi-k3/i, params: null },
  { preset: 'kimi', match: /^kimi-k2\.[56]/i, params: { thinking: { type: 'disabled' } } },
  { preset: 'kimi-global', match: /^kimi-k2\.[56]/i, params: { thinking: { type: 'disabled' } } },

  // --- 智谱：5.3 强制思考 ---
  { preset: 'zhipu', match: /^glm-5\.3/i, params: null },
  { preset: 'zhipu', match: /^glm-5\.2/i, params: { thinking: { type: 'disabled' } } },

  // --- 阿里百炼 ---
  { preset: 'dashscope', match: /.*/, params: { enable_thinking: false } },

  // --- MiniMax：M3.1-Flash 强制思考，传 disabled 会 400 ---
  { preset: 'minimax', match: /^minimax-m3\.1-flash/i, params: null },
  { preset: 'minimax', match: /.*/, params: { thinking: { type: 'disabled' } } },

  // --- OpenRouter 统一开关 ---
  { preset: 'openrouter', match: /.*/, params: { reasoning: { enabled: false } } },

  // --- 硅基流动 ---
  { preset: 'siliconflow', match: /.*/, params: { enable_thinking: false } },

  // --- 商汤：实测无效，仍然发，避免以后支持了却漏掉 ---
  { preset: 'sensenova', match: /.*/, params: { reasoning: { enabled: false } } },
];

/**
 * @param {string | undefined} presetId
 * @param {string | undefined} model
 * @returns {Record<string, unknown> | null} 需要合并进请求体的字段；null 表示不发送
 */
export function reasoningOffParams(presetId, model) {
  const preset = String(presetId ?? '');
  const name = String(model ?? '').trim();
  for (const rule of RULES) {
    if (rule.preset !== preset) continue;
    if (!rule.match.test(name)) continue;
    return rule.params;
  }
  return null;
}
