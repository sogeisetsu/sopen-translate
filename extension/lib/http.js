/**
 * 出网基础设施：超时、429 退避、统一错误类型。
 *
 * 只处理「怎么发请求」，不认识任何厂商或协议。
 *
 * @typedef {Object} PostOptions
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body]
 * @property {number} [timeoutMs]
 * @property {number[]} [retryDelays]
 */

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status) {
    super(message);
    this.name = 'ProviderError';
    /** @type {number | undefined} */
    this.status = status;
  }
}

/**
 * @param {string} message
 * @param {number} [status]
 * @returns {never}
 */
export function fail(message, status) {
  throw new ProviderError(message, status);
}

/** @param {unknown} err @returns {string} */
export function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function clip(text, max = 240) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 拼 URL，去掉两侧多余的斜杠；base 为空时只返回 path。
 * @param {string | undefined} base
 * @param {string} path
 * @returns {string}
 */
export function joinUrl(base, path) {
  const left = String(base ?? '').trim().replace(/\/+$/, '');
  const right = String(path ?? '').trim().replace(/^\/+/, '');
  if (!left) return right;
  if (!right) return left;
  return `${left}/${right}`;
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function requestJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  /** @type {Response} */
  let res;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) fail(`请求超时（${timeoutMs}ms）：${url}`);
    fail(`无法连接 ${url}：${messageOf(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  if (!res.ok) fail(`HTTP ${res.status}：${clip(raw) || res.statusText}`, res.status);
  try {
    return JSON.parse(raw);
  } catch {
    fail(`响应不是合法 JSON：${clip(raw)}`);
  }
}

/**
 * POST JSON。只有 429 进退避重试；401/403/5xx 立刻上抛。
 * @param {string} url
 * @param {PostOptions} [options]
 * @returns {Promise<any>}
 */
export async function postJson(url, options = {}) {
  const {
    headers = {},
    body,
    timeoutMs = 120000,
    retryDelays = [1000, 4000, 10000],
  } = options;

  /** @type {any} */
  let lastError;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await requestJson(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        timeoutMs,
      );
    } catch (err) {
      lastError = err;
      const status = err instanceof ProviderError ? err.status : undefined;
      if (status !== 429 || attempt >= retryDelays.length) throw err;
      await sleep(retryDelays[attempt] ?? 0);
    }
  }
  throw lastError;
}

/**
 * GET JSON。用于模型列表：不重试（包括 429），8 秒超时。
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export async function getJson(url, options = {}) {
  const { headers = {}, timeoutMs = 8000 } = options;
  return requestJson(url, { method: 'GET', headers }, timeoutMs);
}
