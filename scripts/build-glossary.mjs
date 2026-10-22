#!/usr/bin/env node
/**
 * 生成内置术语词库：`extension/lib/glossary-data.json`。
 *
 * 完全离线：只读
 *   - scripts/glossary-allowlist.txt   人工维护的词
 *   - scripts/glossary-snapshot.json   上游筛选快照（入库）
 *   - scripts/glossary-blocklist.txt   误伤词黑名单
 *
 * 跑法：
 *   npm run build:glossary           生成
 *   npm run build:glossary -- --check  只校验已入库文件是否与源一致（忽略 generatedAt）
 *
 * 产物是构建产物，不要手改。
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = path.join(ROOT, 'scripts', 'glossary-allowlist.txt');
const SNAPSHOT = path.join(ROOT, 'scripts', 'glossary-snapshot.json');
const BLOCKLIST = path.join(ROOT, 'scripts', 'glossary-blocklist.txt');
const OUT = path.join(ROOT, 'extension', 'lib', 'glossary-data.json');

const VERSION = 1;
/** 总量硬上限：超了说明该继续人工筛，而不是默默膨胀 */
const MAX_TERMS = 800;

/**
 * @param {string} file
 * @returns {Promise<string[]>}
 */
async function readLines(file) {
  return (await readFile(file, 'utf8')).split(/\r?\n/);
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function meaningfulLines(lines) {
  return lines
    .map((line) => line.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * @param {string} term
 * @param {Set<string>} blocklist
 * @returns {string}
 */
function validate(term, blocklist) {
  if (term.length < 2 || term.length > 60) return '';
  if (/^\d+$/.test(term)) return '';
  if (!/[\p{L}\p{N}]/u.test(term)) return '';
  if (blocklist.has(term.toLowerCase())) return '';
  return term;
}

/**
 * 大小写不敏感去重，保留首次写法。
 * @param {Iterable<string>} terms
 * @returns {string[]}
 */
function dedupe(terms) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/* -------------------------------- 构建 -------------------------------- */

const blocklist = new Set(meaningfulLines(await readLines(BLOCKLIST)).map((term) => term.toLowerCase()));

const allowlist = meaningfulLines(await readLines(ALLOWLIST));

/** @type {any} */
const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8'));

const snapshotTerms = ['brands', 'models', 'cncf']
  .flatMap((key) => (Array.isArray(snapshot[key]) ? snapshot[key] : []))
  .map((term) => String(term));

const candidates = [...allowlist, ...snapshotTerms]
  .map((term) => validate(term, blocklist))
  .filter(Boolean);

const terms = dedupe(candidates).sort((a, b) => a.localeCompare(b, 'en'));

if (terms.length > MAX_TERMS) {
  console.error(
    `词库 ${terms.length} 条，超过硬上限 ${MAX_TERMS}。请继续人工筛选 allowlist / snapshot，或调低脚本里的 CAPS。`,
  );
  process.exit(1);
}

const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];

/** @type {any} */
const output = {
  version: VERSION,
  generatedAt: String(snapshot.generatedAt || ''),
  count: terms.length,
  terms,
  sources,
};

const text = `${JSON.stringify(output, null, 2)}\n`;

/* -------------------------------- 主流程 -------------------------------- */

if (process.argv.includes('--check')) {
  /** @type {any} */
  let existing;
  try {
    existing = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    console.error(`缺少 ${path.relative(ROOT, OUT)}，先跑 npm run build:glossary`);
    process.exit(1);
  }

  const same =
    existing.version === output.version &&
    existing.count === output.count &&
    JSON.stringify(existing.terms) === JSON.stringify(output.terms) &&
    JSON.stringify(existing.sources) === JSON.stringify(output.sources);

  if (!same) {
    console.error('内置词库与源文件不一致，跑 npm run build:glossary 重新生成');
    process.exit(1);
  }
  console.log(`词库已是最新：${output.count} 条`);
  process.exit(0);
}

await writeFile(OUT, text, 'utf8');
console.log(
  `写入 ${path.relative(ROOT, OUT)}：${output.count} 条（allowlist ${allowlist.length} / snapshot ${snapshotTerms.length}）`,
);
