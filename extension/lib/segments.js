/**
 * 从模型返回里抠出 JSON 值 / 分段数组，兼容代码块包裹和多余前后缀。
 *
 * 约定：`null` / `undefined` 段映射成空字符串（表示模型拒绝该段），
 * 解析失败直接抛 `ProviderError`——宁可整批失败，也不要把空串错位写回页面。
 */

import { clip, fail } from './http.js';

/**
 * 从模型返回里抠出 JSON 值，兼容代码块包裹和多余前后缀。
 * @param {unknown} content
 * @returns {any}
 */
export function parseJsonPayload(content) {
  const text = typeof content === 'string' ? content : content == null ? '' : String(content);
  if (!text) fail('模型返回为空');

  const candidates = [text];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      /* 换下一个候选 */
    }
  }
  fail(`无法解析模型返回：${clip(text)}`);
}

/**
 * 从模型返回里抠出分段数组。
 * 约定：`null` / `undefined` 段映射成空字符串（表示模型拒绝该段）。
 * @param {unknown} content
 * @returns {string[]}
 */
export function parseSegments(content) {
  const data = parseJsonPayload(content);
  const arr = Array.isArray(data) ? data : data?.segments;
  if (Array.isArray(arr)) return arr.map((item) => (item == null ? '' : String(item)));
  fail('无法解析模型返回：缺少 segments 数组');
}
