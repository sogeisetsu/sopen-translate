#!/usr/bin/env node
/**
 * 维护者手动跑：联网抓上游数据 → 按规则筛选 → 写 scripts/glossary-snapshot.json。
 *
 * 不参与 `npm run build:glossary`：日常构建完全离线，只读这份快照。
 *
 * 筛选规则（见计划 C1）：
 * - simple-icons：只保留“多词 / 含数字”的标题，过滤通用词；
 * - models.dev：只保留“多词 / 含数字”的模型名；
 * - CNCF glossary：只从中文词条标题里抽 ASCII 片段；
 * - linguist 不批量导入（只用来核对语言名拼写），因此这里不抓。
 *
 * 跑法：npm run build:glossary:snapshot
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts', 'glossary-snapshot.json');
const BLOCKLIST = path.join(ROOT, 'scripts', 'glossary-blocklist.txt');

const USER_AGENT = 'sopen-translate-glossary-snapshot/1.0 (+https://github.com/sogeisetsu/sopen-translate)';
const CAPS = { brands: 220, models: 160, cncf: 120 };

const SOURCES = {
  brands: {
    name: 'simple-icons',
    url: 'https://unpkg.com/simple-icons@latest/data/simple-icons.json',
    license: 'CC0 1.0',
    note: 'extracted icon titles only, filtered generic words',
  },
  models: {
    name: 'models.dev',
    url: 'https://models.dev/api.json',
    license: '未标注（仅使用名称清单）',
    note: 'model names only, filtered generic words',
  },
  cncf: {
    name: 'CNCF Glossary',
    url: 'https://github.com/cncf/glossary/tree/main/content/zh-cn',
    license: 'CC BY 4.0',
    note: 'ASCII term fragments extracted from zh-cn glossary titles only',
  },
};

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} url
 * @param {{ retries?: number, timeoutMs?: number, json?: boolean }} [options]
 * @returns {Promise<string>}
 */
async function fetchText(url, { retries = 3, timeoutMs = 30000, json = false } = {}) {
  /** @type {unknown} */
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: json ? 'application/json' : 'text/plain,text/markdown,*/*',
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** @param {string} url @returns {Promise<any>} */
async function fetchJson(url) {
  return JSON.parse(await fetchText(url, { json: true }));
}

/** @param {string[]} lines @returns {Set<string>} */
function toBlocklist(lines) {
  return new Set(
    lines
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith('#')),
  );
}

/**
 * @param {unknown} term
 * @param {Set<string>} blocklist
 * @param {{ requireMultiWord?: boolean, minLength?: number }} [options]
 * @returns {string}
 */
function normalizeCandidate(term, blocklist, { requireMultiWord = true, minLength = 2 } = {}) {
  const value = String(term ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length < minLength || value.length > 60) return '';
  if (!/^[\x20-\x7e]+$/.test(value)) return '';
  if (!/[A-Za-z]/.test(value)) return '';
  if (/^\d+$/.test(value)) return '';
  if (blocklist.has(value.toLowerCase())) return '';
  if (requireMultiWord && !/[\s\d]/.test(value)) return '';
  return value;
}

/**
 * 长的更具体，优先保留；同长度按字典序，保证可复现。
 * @param {Iterable<string>} values
 * @param {number} cap
 * @returns {string[]}
 */
function pick(values, cap) {
  return [...new Set(values)]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, cap)
    .sort();
}

/* ------------------------------ 各数据源 ------------------------------ */

/** @param {Set<string>} blocklist */
async function fromSimpleIcons(blocklist) {
  const data = await fetchJson(SOURCES.brands.url);
  const list = Array.isArray(data) ? data : [];
  /** @type {string[]} */
  const values = [];
  for (const item of list) {
    const title = typeof item === 'string' ? item : item?.title;
    const value = normalizeCandidate(title, blocklist);
    if (value) values.push(value);
  }
  console.error(`simple-icons: ${list.length} titles → ${values.length} candidates`);
  return pick(values, CAPS.brands);
}

/**
 * models.dev 的结构是 `{ <provider>: { models: { <id>: { name } } } }`，
 * 这里递归找所有 `models` 对象，不依赖具体层级。
 * @param {Set<string>} blocklist
 */
async function fromModelsDev(blocklist) {
  const data = await fetchJson(SOURCES.models.url);
  /** @type {Set<string>} */
  const names = new Set();

  /** @param {any} node */
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.models && typeof node.models === 'object' && !Array.isArray(node.models)) {
      for (const [id, value] of Object.entries(node.models)) {
        names.add(id);
        if (value && typeof value === 'object' && typeof (/** @type {any} */ (value).name) === 'string') {
          names.add(/** @type {any} */ (value).name);
        }
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(data);

  /** @type {string[]} */
  const values = [];
  for (const name of names) {
    const value = normalizeCandidate(name, blocklist);
    if (value) values.push(value);
  }
  console.error(`models.dev: ${names.size} names → ${values.length} candidates`);
  return pick(values, CAPS.models);
}

/**
 * 只抽中文词条标题里的 ASCII 片段；纯中文标题自然没有片段。
 *
 * 抓 tarball（一次请求）而不是逐个文件：GitHub 的 contents 目录列表不带
 * base64 内容，逐文件走 raw.githubusercontent.com 在部分网络里不可达。
 * @param {Set<string>} blocklist
 */
async function fromCncf(blocklist) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  /** @type {Buffer} */
  let tar;
  try {
    const res = await fetch('https://api.github.com/repos/cncf/glossary/tarball/main', {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tar = gunzipSync(Buffer.from(await res.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }

  /** @type {Set<string>} */
  const fragments = new Set();
  let files = 0;

  for (const [name, data] of readTar(tar)) {
    if (!name.includes('/content/zh-cn/') || !name.endsWith('.md')) continue;
    files += 1;
    const title = data.toString('utf8').match(/^#\s+(.+)$/m)?.[1] || '';
    const pieces = title.match(/[A-Za-z][A-Za-z0-9.+-]*/g) || [];
    for (const piece of pieces) {
      const value = normalizeCandidate(piece, blocklist, { requireMultiWord: false, minLength: 3 });
      if (value) fragments.add(value);
    }
  }

  console.error(`CNCF: ${files} files → ${fragments.size} candidates`);
  return pick(fragments, CAPS.cncf);
}

/**
 * 最小 tar 读取：只认普通文件，够解析 GitHub 的 tarball。
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
function readTar(buffer) {
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  let offset = 0;

  /** @param {Buffer} header @param {number} start @param {number} length */
  const cstr = (header, start, length) => {
    const slice = header.subarray(start, start + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
  };

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    const name = cstr(header, 0, 100);
    if (!name) break;

    const size = parseInt(cstr(header, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = cstr(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const start = offset + 512;

    if (type === '0' || type === '\u0000') {
      files.set(fullName, buffer.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }

  return files;
}

/* -------------------------------- 主流程 -------------------------------- */

const blocklist = toBlocklist((await readFile(BLOCKLIST, 'utf8')).split(/\r?\n/));

/** @type {{ brands: string[], models: string[], cncf: string[], sources: any[] }} */
const result = { brands: [], models: [], cncf: [], sources: [] };

try {
  result.brands = await fromSimpleIcons(blocklist);
  result.sources.push(SOURCES.brands);
} catch (err) {
  console.error('simple-icons 抓取失败，跳过：', err instanceof Error ? err.message : err);
}

try {
  result.models = await fromModelsDev(blocklist);
  result.sources.push(SOURCES.models);
} catch (err) {
  console.error('models.dev 抓取失败，跳过：', err instanceof Error ? err.message : err);
}

try {
  result.cncf = await fromCncf(blocklist);
  if (result.cncf.length > 0) result.sources.push(SOURCES.cncf);
} catch (err) {
  console.error('CNCF 抓取失败，跳过：', err instanceof Error ? err.message : err);
}

const snapshot = {
  generatedAt: new Date().toISOString().slice(0, 10),
  sources: result.sources,
  brands: result.brands,
  models: result.models,
  cncf: result.cncf,
};

await writeFile(OUT, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.error(
  `写入 ${path.relative(ROOT, OUT)}：brands ${snapshot.brands.length} / models ${snapshot.models.length} / cncf ${snapshot.cncf.length}`,
);
