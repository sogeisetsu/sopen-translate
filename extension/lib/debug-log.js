/**
 * 调试日志（纯函数）：条目结构、脱敏、截断、环形缓冲、导出格式。
 *
 * 不读 `chrome.*`、不联网。真正写盘的是 background 的 `debug.log` 消息，
 * 这样 content / options / popup 不会并发覆盖同一个 storage key。
 *
 * 硬约束：
 * - 默认不记录请求头、响应体、页面 DOM；
 * - key / Authorization / URL query 里的 key 一律替换成 ***；
 * - 页面正文只有在 `debugLogSamples` 显式开启时才记录，且每段最多 120 字。
 *
 * @typedef {import('../../types').DebugLogEntry} DebugLogEntry
 * @typedef {import('../../types').DebugLogExport} DebugLogExport
 * @typedef {import('../../types').Settings} Settings
 */

export const DEBUG_LOG_MAX_ENTRIES = 500;
/** 约 1MB：按 JSON 序列化长度估算，不追求精确字节 */
export const DEBUG_LOG_MAX_BYTES = 1024 * 1024;
/** 单条超过 8KB 截断 */
export const DEBUG_LOG_MAX_ENTRY_CHARS = 8 * 1024;
/** 样本最多 120 字 */
export const DEBUG_LOG_SAMPLE_CHARS = 120;

/** 一律替换成 *** 的字段名（大小写不敏感） */
const SECRET_FIELDS = [
  'apikey',
  'api_key',
  'authorization',
  'token',
  'session',
  'x-opencode-session',
  'ocp-apim-subscription-key',
  'ocp-apim-subscription-region',
  'deepl-auth-key',
];

/** @param {unknown} value @returns {boolean} */
function isSecretField(value) {
  const key = String(value ?? '').toLowerCase();
  return SECRET_FIELDS.some((field) => key === field || key.endsWith(`_${field}`));
}

/**
 * 字符串脱敏。宁可多替换，也不要把 key 写进导出文件。
 * @param {unknown} value
 * @returns {string}
 */
export function redactText(value) {
  let text = String(value ?? '');
  // Authorization: Bearer xxx / 裸 Bearer xxx
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{6,}=*/gi, '$1***');
  // DeepL-Auth-Key xxx
  text = text.replace(/(DeepL-Auth-Key\s+)[^\s"',}]+/gi, '$1***');
  // 具名请求头
  text = text.replace(
    /((?:x-opencode-session|Ocp-Apim-Subscription-Key|Ocp-Apim-Subscription-Region)\s*[:=]\s*"?)[^"\s,}&]+/gi,
    '$1***',
  );
  // URL query：Gemini 的 key 就在 query 里
  text = text.replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi, '$1***');
  // JSON 属性
  text = text.replace(
    /("(?:apiKey|api_key|apikey|token|authorization|access_token)"\s*:\s*)"[^"]*"/gi,
    '$1"***"',
  );
  // 常见 key 形态兜底（sk-... / nvapi-...）
  text = text.replace(/\b(sk|nvapi)-[A-Za-z0-9_-]{8,}/g, '$1-***');
  return text;
}

/**
 * 递归脱敏 data：字段名命中 SECRET_FIELDS 的值直接替换，字符串统一过 redactText。
 * 深度与数组长度都设上限，避免一份错误对象把日志撑爆。
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactValue(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    let count = 0;
    for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (count >= 30) break;
      count += 1;
      out[key] = isSecretField(key) ? '***' : redactValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clipText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 构造一条日志。所有字符串都脱敏，data 递归脱敏。
 * @param {Partial<DebugLogEntry> & { now?: number }} input
 * @returns {DebugLogEntry}
 */
export function makeDebugEntry(input) {
  const level =
    input.level === 'warn' || input.level === 'error' || input.level === 'info'
      ? input.level
      : 'info';
  const source =
    input.source === 'content' ||
    input.source === 'background' ||
    input.source === 'options' ||
    input.source === 'popup'
      ? input.source
      : 'background';

  /** @type {DebugLogEntry} */
  const entry = {
    v: 1,
    ts: new Date(typeof input.now === 'number' ? input.now : Date.now()).toISOString(),
    level,
    event: clipText(input.event, 80) || 'event',
    source,
  };
  if (Number.isInteger(input.tabId)) entry.tabId = Number(input.tabId);
  if (input.url) entry.url = clipText(redactText(input.url), 300);
  if (input.title) entry.title = clipText(redactText(input.title), 200);
  if (input.message) entry.message = clipText(redactText(input.message), 600);
  if (input.data && typeof input.data === 'object') {
    entry.data = /** @type {Record<string, unknown>} */ (redactValue(input.data));
  }
  if (input.note) entry.note = clipText(redactText(input.note), 600);
  return truncateEntry(entry);
}

/**
 * 单条超长截断：先丢 data，再截 message；保证 JSON 长度不超上限。
 * @param {DebugLogEntry} entry
 * @returns {DebugLogEntry}
 */
export function truncateEntry(entry) {
  if (JSON.stringify(entry).length <= DEBUG_LOG_MAX_ENTRY_CHARS) return entry;
  const withoutData = { ...entry };
  delete withoutData.data;
  if (JSON.stringify(withoutData).length <= DEBUG_LOG_MAX_ENTRY_CHARS) return withoutData;
  return {
    ...withoutData,
    message: clipText(withoutData.message ?? '', 400) || '[truncated]',
    title: clipText(withoutData.title ?? '', 80),
  };
}

/**
 * 环形缓冲：先按 500 条淘汰，再按约 1MB 淘汰最旧。
 * @param {DebugLogEntry[] | undefined} entries
 * @param {DebugLogEntry} entry
 * @returns {DebugLogEntry[]}
 */
export function appendDebugEntry(entries, entry) {
  /** @type {DebugLogEntry[]} */
  const list = Array.isArray(entries) ? entries.filter(Boolean).slice() : [];
  list.push(entry);
  while (list.length > DEBUG_LOG_MAX_ENTRIES) list.shift();

  let size = list.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
  while (size > DEBUG_LOG_MAX_BYTES && list.length > 1) {
    const removed = list.shift();
    if (removed) size -= JSON.stringify(removed).length;
  }
  return list;
}

/**
 * 设置摘要：给排障用，但不含任何 key。
 * @param {Settings | null | undefined} settings
 * @returns {Record<string, unknown>}
 */
export function summarizeSettings(settings) {
  if (!settings || typeof settings !== 'object') return {};
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  const active = providers.find((provider) => provider.id === settings.activeProviderId);
  return {
    targetLang: settings.targetLang,
    targetLangCode: settings.targetLangCode,
    displayMode: settings.displayMode,
    translateScope: settings.translateScope,
    enforcement: settings.enforcement,
    glossary: {
      useBuiltin: Boolean(settings.glossary?.useBuiltin),
      customTerms: Array.isArray(settings.glossary?.terms) ? settings.glossary.terms.length : 0,
    },
    reviewProviderConfigured: Boolean(settings.reviewProviderId),
    debugLogEnabled: Boolean(settings.debugLogEnabled),
    debugLogSamples: Boolean(settings.debugLogSamples),
    activeProvider: active
      ? {
          presetId: active.presetId,
          protocol: active.protocol,
          model: active.model,
          baseUrl: active.baseUrl,
          hasKey: Boolean(active.apiKey),
          sourceLang: active.sourceLang,
        }
      : null,
    providers: providers.map((provider) => ({
      presetId: provider.presetId,
      protocol: provider.protocol,
      model: provider.model,
      hasKey: Boolean(provider.apiKey),
    })),
  };
}

/**
 * 导出文件：可直接被 Node `JSON.parse`。
 * @param {Object} args
 * @param {DebugLogEntry[]} args.entries
 * @param {Settings | null | undefined} args.settings
 * @param {string} args.appVersion
 * @param {string} [args.ua]
 * @param {boolean} [args.samples]
 * @param {number} [args.now]
 * @returns {DebugLogExport}
 */
export function buildDebugExport({ entries, settings, appVersion, ua = '', samples = false, now }) {
  return {
    appVersion: String(appVersion ?? ''),
    ua: redactText(ua),
    exportedAt: new Date(typeof now === 'number' ? now : Date.now()).toISOString(),
    samples: Boolean(samples),
    settings: summarizeSettings(settings),
    entries: (Array.isArray(entries) ? entries : []).map((entry) => truncateEntry(entry)),
  };
}

/**
 * 选项页“最近 50 条”的一行文本。
 * @param {DebugLogEntry} entry
 * @returns {string}
 */
export function formatDebugLine(entry) {
  const time = String(entry.ts ?? '').slice(11, 19);
  const level = String(entry.level ?? 'info').toUpperCase().padEnd(5, ' ');
  const message = entry.message ? ` ${entry.message}` : '';
  const note = entry.note ? `（${entry.note}）` : '';
  return `${time} ${level} ${entry.event}${message}${note}`;
}

/**
 * 用户显式开启 samples 时的样本截断。
 * @param {unknown} text
 * @returns {string}
 */
export function sampleText(text) {
  return clipText(redactText(text), DEBUG_LOG_SAMPLE_CHARS);
}
