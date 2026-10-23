/**
 * 工具栏弹窗：翻译 / 还原、展示模式、范围、目标语言、进度与审校详情。
 *
 * 真正的状态都在 content script 里；关掉弹窗不影响翻译继续，
 * 重新打开会从 `page.status` 恢复进度、「还原」与审校摘要。
 *
 * 约定：
 * - 只发消息，不碰页面 DOM；
 * - `page.status` 每 500ms 轮询一次，`pagehide` 时停；
 * - 审校详情读的是 content 的内存日志（最多 100 条），不写存储。
 */

import { getSettings, saveSettings } from './lib/settings.js';
import { LANGUAGES, findLanguage } from './lib/languages.js';

/** @typedef {import('../types').Settings} Settings */
/** @typedef {import('../types').DisplayMode} DisplayMode */
/** @typedef {import('../types').TranslateScope} TranslateScope */
/** @typedef {import('../types').ReviewLogEntry} ReviewLogEntry */
/** @typedef {import('../types').ReviewStatus} ReviewStatus */
/**
 * @typedef {{
 *   translated: number,
 *   busy: boolean,
 *   mode?: DisplayMode,
 *   scope?: TranslateScope,
 *   pending?: boolean,
 *   progress?: { done: number, total: number },
 *   review?: ReviewStatus,
 * }} PageStatus
 */
/**
 * @typedef {{
 *   reviewed: number,
 *   corrected: number,
 *   rejected?: number,
 *   failed: boolean,
 *   truncated: boolean,
 *   pending: boolean,
 * }} ReviewSummary
 */
/** @typedef {{ ok?: boolean, log?: ReviewLogEntry[], summary?: ReviewSummary }} ReviewLogResponse */
/** @typedef {'idle' | 'busy' | 'restore' | 'blocked'} ActionState */

const POLL_INTERVAL = 500;
/** 主翻译结束后审校可能还在跑：最多再轮询 3 分钟 */
const REVIEW_WAIT_MAX = 180000;

/** 规则原因码 / 驳回原因 → 中文短标签 */
/** @type {Record<string, string>} */
const REASON_LABELS = {
  empty: '空译',
  same: '与原文相同',
  term: '术语缺失',
  numbers: '数字不一致',
  url: '链接不一致',
  placeholder: '占位符不一致',
  script: '目标文字不符',
  length: '长度异常',
  duplicate: '重复',
  'same-primary': '与主译相同',
  'same-source': '与原文相同',
  html: '标签不一致',
  unchanged: '模型未改',
  detached: '页面已变化',
};

/* -------------------------------- 元素 -------------------------------- */

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function pick(id, type) {
  const element = document.getElementById(id);
  if (!element || !(element instanceof type)) throw new Error(`弹窗缺少元素 #${id}`);
  return element;
}

/** @param {string} name @returns {HTMLInputElement[]} */
function radios(name) {
  return Array.from(document.querySelectorAll(`input[name="${name}"]`)).map(
    (element) => /** @type {HTMLInputElement} */ (element),
  );
}

const providerEl = pick('provider', HTMLElement);
const targetEl = pick('target', HTMLElement);
const debugBadge = pick('debug-badge', HTMLElement);

const mainBtn = pick('main', HTMLButtonElement);
const mainLabel = pick('main-label', HTMLElement);
const mainCount = pick('main-count', HTMLElement);
const mainProgress = pick('main-progress', HTMLElement);

const statusEl = pick('status', HTMLElement);
const reviewStatusEl = pick('review-status', HTMLElement);
const reviewStatusText = pick('review-status-text', HTMLElement);
const reviewStatusFlag = pick('review-status-flag', HTMLElement);

const modeInputs = radios('display-mode');
const scopeInputs = radios('translate-scope');
const langEl = pick('target-lang', HTMLSelectElement);

const reviewToggle = pick('review-toggle', HTMLButtonElement);
const reviewMeta = pick('review-meta', HTMLElement);
const reviewPanel = pick('review-panel', HTMLElement);
const reviewSummary = pick('review-summary', HTMLElement);
const reviewList = pick('review-list', HTMLElement);
const reviewMore = pick('review-more', HTMLElement);
const reviewUndo = pick('review-undo', HTMLButtonElement);
const reviewUndoStatus = pick('review-undo-status', HTMLElement);

const openOptions = pick('open-options', HTMLAnchorElement);
const openDebug = pick('open-debug', HTMLAnchorElement);

const state = {
  /** @type {Settings | null} */
  settings: null,
  /** @type {PageStatus | null} */
  page: null,
  /** @type {number | null} */
  tabId: null,
  supported: true,
  hasProvider: false,
  /**
   * 有请求在飞：不等轮询就先锁住按钮，避免连点
   * @type {'translate' | 'restore' | null}
   */
  inFlight: null,
  /** @type {ReturnType<typeof setInterval> | null} */
  timer: null,
  polling: false,
  /** 主翻译已结束，但还要等审校收尾 */
  waitReview: false,
  pollDeadline: 0,
  /** @type {ReviewLogEntry[]} */
  reviewLog: [],
  /** @type {ReviewSummary | null} */
  reviewSummary: null,
  /** 审校计数签名：变了才去拉日志 */
  reviewSig: '',
  /** 列表签名：内容没变就不重建，保住滚动位置 */
  reviewListSig: '',
  reviewLoading: false,
  /** @type {{ text: string, error: boolean } | null} */
  notice: null,
};

/* -------------------------------- 小工具 -------------------------------- */

/** @param {unknown} err @returns {string} */
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 只在文本变化时写入，避免 aria-live 反复播报同一句
 * @param {HTMLElement} element
 * @param {string} text
 */
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

/**
 * @param {string} text
 * @param {{ error?: boolean, tone?: 'ok' | '' }} [options]
 */
function setStatus(text, { error = false, tone = '' } = {}) {
  setText(statusEl, text);
  statusEl.classList.toggle('is-error', error);
  statusEl.dataset.tone = tone;
}

/**
 * 一次性提示（错误、已还原、切换后需重新翻译）：一直显示到用户下一次操作，
 * 不会在 500ms 轮询里被默认状态行盖掉。
 * @param {string} text
 * @param {{ error?: boolean }} [options]
 */
function setNotice(text, { error = false } = {}) {
  state.notice = text ? { text, error } : null;
}

/**
 * @param {ActionState} next
 * @param {string} label
 * @param {{ disabled?: boolean, count?: string, progress?: number }} [options]
 */
function setAction(next, label, { disabled = false, count = '', progress = 0 } = {}) {
  mainBtn.dataset.state = next;
  mainBtn.disabled = disabled;
  setText(mainLabel, label);
  mainCount.hidden = !count;
  setText(mainCount, count);
  const percent = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)) * 100;
  mainProgress.style.setProperty('--p', `${percent}%`);
}

/* -------------------------------- 渲染 -------------------------------- */

/** 主按钮下面那行默认文案 @returns {{ text: string, error: boolean, tone: 'ok' | '' }} */
function defaultStatus() {
  const page = state.page;

  if (!state.hasProvider) return { text: '先去设置页添加一个翻译服务', error: true, tone: '' };
  if (!state.supported) return { text: '这个页面不支持翻译', error: true, tone: '' };
  if (state.inFlight === 'restore') return { text: '正在还原…', error: false, tone: '' };
  if (state.inFlight || page?.busy) {
    const mode = page?.mode === 'bilingual' ? '（双语）' : '';
    return { text: `正在翻译${mode}…`, error: false, tone: '' };
  }

  const translated = page?.translated ?? 0;
  if (translated > 0) {
    const unit = page?.mode === 'bilingual' ? '块' : '段';
    const more = page?.pending ? ' · 滚动继续翻译' : '';
    return { text: `已翻译 ${translated} ${unit}${more}`, error: false, tone: 'ok' };
  }
  if (page?.pending) return { text: '滚动页面会继续翻译', error: false, tone: '' };
  return { text: '', error: false, tone: '' };
}

function render() {
  const page = state.page;
  const busy = Boolean(state.inFlight || page?.busy);
  const translated = page?.translated ?? 0;

  if (!state.hasProvider || !state.supported) {
    setAction('blocked', '翻译', { disabled: true });
  } else if (busy) {
    const restoring = state.inFlight === 'restore';
    const progress = page?.busy ? page?.progress : undefined;
    const total = restoring ? 0 : (progress?.total ?? 0);
    const done = restoring ? 0 : (progress?.done ?? 0);
    setAction('busy', restoring ? '还原中' : '翻译中', {
      disabled: true,
      count: total > 0 ? `${done}/${total}` : '',
      progress: total > 0 ? done / total : 0,
    });
  } else if (translated > 0) {
    // 还原优先：只要页面上还有译文，主按钮就是「还原」
    setAction('restore', '还原');
  } else {
    setAction('idle', '翻译');
  }

  // 翻译中不改设置：background 每批读一次，中途改会让同页前后批次不一致
  for (const input of modeInputs) input.disabled = busy;
  for (const input of scopeInputs) input.disabled = busy;
  langEl.disabled = busy;

  if (state.notice) {
    setStatus(state.notice.text, { error: state.notice.error });
  } else {
    const next = defaultStatus();
    setStatus(next.text, { error: next.error, tone: next.tone });
  }

  renderReviewStatus();
  renderReview();
}

function renderReviewStatus() {
  const review = state.page?.review;
  const reviewed = review?.reviewed ?? 0;
  const pending = Boolean(review?.pending);
  const show = Boolean(review && (pending || reviewed > 0));

  reviewStatusEl.hidden = !show;
  if (!show || !review) return;

  const parts = [];
  if (reviewed > 0) parts.push(`已审校 ${reviewed} 段，修正 ${review.corrected} 段`);
  if (pending) parts.push('审校中…');
  setText(reviewStatusText, parts.join(' · '));
  reviewStatusEl.dataset.state = pending ? 'pending' : 'done';

  const flags = [];
  if (review.failed) flags.push('失败，保留主译文');
  if (review.truncated) flags.push('预算已满');
  setText(reviewStatusFlag, flags.join(' · '));
  reviewStatusFlag.hidden = flags.length === 0;
  reviewStatusFlag.dataset.tone = review.failed ? 'danger' : 'warn';
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {string} code @returns {string} */
function reasonLabel(code) {
  return REASON_LABELS[code] || code;
}

/**
 * @param {string} key
 * @param {string} text
 * @param {string} [extraClass]
 * @returns {HTMLElement}
 */
function reviewRow(key, text, extraClass = '') {
  const row = el('div', 'review-row');
  row.append(
    el('span', 'review-key', key),
    el('p', extraClass ? `review-text ${extraClass}` : 'review-text', text),
  );
  return row;
}

/** @param {ReviewLogEntry} entry @returns {{ text: string, tone: 'ok' | 'warn' | 'muted' }} */
function stateTag(entry) {
  if (entry.applied) return { text: '已写回', tone: 'ok' };

  const reason = entry.rejectedReason ? reasonLabel(entry.rejectedReason) : '';
  if (entry.corrected) {
    return { text: reason ? `未写回 · ${reason}` : '未写回', tone: 'warn' };
  }
  if (entry.rejectedReason === 'unchanged') return { text: '模型未改', tone: 'muted' };
  return { text: reason ? `未采用 · ${reason}` : '未采用', tone: 'warn' };
}

function renderReviewSummary() {
  const summary = state.reviewSummary;
  const live = state.page?.review;
  const reviewed = summary?.reviewed ?? live?.reviewed ?? 0;
  const corrected = summary?.corrected ?? live?.corrected ?? 0;
  const rejected = summary?.rejected ?? Math.max(0, reviewed - corrected);

  reviewSummary.replaceChildren(
    el('span', 'review-summary-count', `送审 ${reviewed} · 修正 ${corrected} · 保留 ${rejected}`),
  );

  const failed = Boolean(summary?.failed ?? live?.failed);
  const truncated = Boolean(summary?.truncated ?? live?.truncated);
  if (failed) reviewSummary.append(el('span', 'tag is-warn', '失败'));
  if (truncated) reviewSummary.append(el('span', 'tag is-warn', '预算已满'));
}

/** @param {ReviewLogEntry[]} log */
function renderReviewList(log) {
  const items = log.map((entry) => {
    const item = el('li', 'review-item');
    item.append(reviewRow('原文', entry.source), reviewRow('主译', entry.primary, 'is-primary'));
    if (entry.corrected) item.append(reviewRow('修正', entry.corrected, 'is-corrected'));

    const tags = el('div', 'tags');
    const tag = stateTag(entry);
    tags.append(el('span', `tag is-${tag.tone}`, tag.text));
    for (const reason of Array.isArray(entry.reasons) ? entry.reasons : []) {
      // 驳回原因已经写在状态标签里，别再重复一遍
      if (reason === entry.rejectedReason) continue;
      tags.append(el('span', 'tag is-warn', reasonLabel(reason)));
    }
    item.append(tags);
    return item;
  });

  reviewList.replaceChildren(...items);
}

function collapseReview() {
  reviewToggle.setAttribute('aria-expanded', 'false');
  reviewPanel.hidden = true;
}

function renderReview() {
  const log = state.reviewLog;
  const hasLog = log.length > 0;
  const applied = log.filter((entry) => entry.applied).length;

  reviewToggle.hidden = !hasLog;
  if (!hasLog) collapseReview();

  const live = state.page?.review;
  setText(
    reviewMeta,
    live ? `${live.reviewed} 段 · 修正 ${live.corrected}` : `${log.length} 条`,
  );

  if (reviewPanel.hidden) return;

  renderReviewSummary();

  const signature = log
    .map((entry) => `${entry.id}:${entry.applied ? 1 : 0}:${entry.corrected ? 1 : 0}:${entry.rejectedReason ?? ''}`)
    .join('|');
  if (signature !== state.reviewListSig) {
    state.reviewListSig = signature;
    renderReviewList(log);
  }

  reviewUndo.disabled = applied === 0;

  // 列表被截断时给一句说明，否则没有滚动条的时候看起来像内容缺失
  const scrollable = reviewList.scrollHeight > reviewList.clientHeight + 2;
  reviewList.classList.toggle('is-scrollable', scrollable);
  reviewMore.hidden = !scrollable;
  setText(reviewMore, scrollable ? `共 ${log.length} 条，上下滚动查看` : '');
}

/* -------------------------------- 消息 -------------------------------- */

/**
 * 目标页可能不允许注入（chrome:// 等），统一转成可读提示。
 * 这里不改 `supported`：只有 `page.status` 失败才说明页面不可用，
 * `page.review` 之类的附加消息失败不应把主按钮判成「不支持」。
 * @param {number} tabId
 * @param {unknown} message
 */
async function askTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    throw new Error('这个页面不支持翻译');
  }
}

/** @param {number} tabId @returns {Promise<PageStatus | null>} */
async function readPageStatus(tabId) {
  try {
    const page = /** @type {PageStatus} */ (await askTab(tabId, { type: 'page.status' }));
    state.page = page;
    state.supported = true;
    return page;
  } catch {
    state.page = null;
    state.supported = false;
    return null;
  }
}

/** 清空审校视图：重新翻译 / 还原时 content 已经换了新日志 */
function resetReview() {
  state.reviewLog = [];
  state.reviewSummary = null;
  state.reviewSig = '';
  state.reviewListSig = '';
  if (state.page) {
    state.page.review = { pending: false, reviewed: 0, corrected: 0, failed: false, truncated: false };
  }
  collapseReview();
  setText(reviewUndoStatus, '');
  renderReview();
}

async function loadReviewLog() {
  const tabId = state.tabId;
  if (tabId == null || state.reviewLoading) return;

  state.reviewLoading = true;
  try {
    const res = /** @type {ReviewLogResponse} */ (await askTab(tabId, { type: 'page.review' }));
    if (Array.isArray(res?.log)) state.reviewLog = /** @type {ReviewLogEntry[]} */ (res.log);
    if (res?.summary) state.reviewSummary = res.summary;
  } catch {
    // 页面跳走或关掉：保留上次内容，下次轮询再试
  } finally {
    state.reviewLoading = false;
    renderReview();
  }
}

/** 审校计数变了才拉日志：轮询很密，别每次都发消息 */
function syncReview() {
  const review = state.page?.review;
  const signature = review
    ? `${review.reviewed}:${review.corrected}:${review.pending}:${review.failed}:${review.truncated}`
    : '';
  if (signature === state.reviewSig) return;
  state.reviewSig = signature;

  if (!review || review.reviewed === 0) {
    state.reviewLog = [];
    state.reviewSummary = null;
    state.reviewListSig = '';
    collapseReview();
    renderReview();
    return;
  }

  void loadReviewLog();
}

/* -------------------------------- 轮询 -------------------------------- */

function stopPolling() {
  if (state.timer !== null) clearInterval(state.timer);
  state.timer = null;
  state.polling = false;
  state.waitReview = false;
}

/**
 * @param {number} tabId
 * @param {{ waitReview?: boolean }} [options]
 */
function startPolling(tabId, { waitReview = false } = {}) {
  stopPolling();
  state.waitReview = waitReview;
  state.pollDeadline = Date.now() + REVIEW_WAIT_MAX;

  state.timer = setInterval(async () => {
    if (state.polling) return;
    state.polling = true;
    try {
      const page = await readPageStatus(tabId);
      if (!page) {
        stopPolling();
        render();
        return;
      }
      syncReview();
      render();

      // 主翻译结束后还留着轮询：只为了把「审校中…」等到收尾
      if (state.waitReview && !page.review?.pending) stopPolling();
      else if (state.waitReview && Date.now() > state.pollDeadline) stopPolling();
    } finally {
      state.polling = false;
    }
  }, POLL_INTERVAL);
}

/* -------------------------------- 启动状态 -------------------------------- */

function buildLanguageOptions() {
  langEl.replaceChildren();
  const settings = state.settings;
  const known = findLanguage(settings?.targetLang);

  if (settings && !known) {
    const current = settings.targetLang || '（空）';
    const option = new Option(`当前：${current}（不在列表）`, current, true, true);
    option.disabled = true;
    langEl.append(option);
  }

  for (const language of LANGUAGES) {
    langEl.append(new Option(language.name, language.name, false, known?.id === language.id));
  }
}

function buildMode() {
  const mode = state.settings?.displayMode === 'bilingual' ? 'bilingual' : 'translation';
  for (const input of modeInputs) input.checked = input.value === mode;
}

function buildScope() {
  const scope = state.settings?.translateScope === 'whole' ? 'whole' : 'viewport';
  for (const input of scopeInputs) input.checked = input.value === scope;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  state.hasProvider = Boolean(status?.ok && status.active);

  if (!state.hasProvider) {
    setText(providerEl, status?.providerCount ? '未选择默认服务' : '未配置服务');
    setText(targetEl, '—');
    render();
    return;
  }

  setText(providerEl, status.active.label || '已配置服务');
  setText(targetEl, status.targetLang || '—');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  if (state.tabId == null) {
    state.supported = false;
    render();
    return;
  }

  await readPageStatus(state.tabId);
  syncReview();
  render();
}

/* -------------------------------- 交互 -------------------------------- */

mainBtn.addEventListener('click', async () => {
  const tabId = state.tabId;
  if (tabId == null) return;

  const restore = mainBtn.dataset.state === 'restore';
  setNotice('');
  state.inFlight = restore ? 'restore' : 'translate';
  render();

  if (restore) {
    try {
      const result = await askTab(tabId, { type: 'page.restore' });
      if (!result?.ok) throw new Error(result?.error || '还原失败');
      resetReview();
      setNotice(`已还原 ${result.restored ?? 0} 处`);
    } catch (err) {
      setNotice(errorText(err), { error: true });
    }
    state.inFlight = null;
    await readPageStatus(tabId);
    syncReview();
    render();
    return;
  }

  resetReview();
  startPolling(tabId);
  try {
    const result = await askTab(tabId, { type: 'page.translate' });
    if (!result?.ok) throw new Error(result?.error || '翻译失败');
    if ((result.translated ?? 0) === 0) setNotice('没有找到可翻译的文本');
  } catch (err) {
    setNotice(errorText(err), { error: true });
  } finally {
    state.inFlight = null;
    const page = await readPageStatus(tabId);
    syncReview();
    // 审校是异步的：主译文落地后还可能有修正，继续轮询到它收尾
    if (page?.review?.pending) startPolling(tabId, { waitReview: true });
    else stopPolling();
    render();
  }
});

for (const input of modeInputs) {
  input.addEventListener('change', async () => {
    if (!input.checked || !state.settings) return;
    const mode = /** @type {DisplayMode} */ (input.value);
    if (state.settings.displayMode === mode) return;

    try {
      state.settings = await saveSettings({ displayMode: mode });
      buildMode();
      setNotice(
        (state.page?.translated ?? 0) > 0 ? '已切换；点「还原」后重新翻译生效' : '',
      );
    } catch (err) {
      buildMode();
      setNotice(errorText(err), { error: true });
    }
    render();
  });
}

for (const input of scopeInputs) {
  input.addEventListener('change', async () => {
    if (!input.checked || !state.settings) return;
    const scope = /** @type {TranslateScope} */ (input.value);
    if (state.settings.translateScope === scope) return;

    try {
      state.settings = await saveSettings({ translateScope: scope });
      buildScope();
      setNotice(
        (state.page?.translated ?? 0) > 0 ? '已切换；点「还原」后重新翻译生效' : '',
      );
    } catch (err) {
      buildScope();
      setNotice(errorText(err), { error: true });
    }
    render();
  });
}

langEl.addEventListener('change', async () => {
  const language = findLanguage(langEl.value);
  if (!language || !state.settings) {
    buildLanguageOptions();
    return;
  }

  try {
    state.settings = await saveSettings({
      targetLang: language.name,
      targetLangCode: language.code,
    });
    setText(targetEl, language.name);
    setNotice((state.page?.translated ?? 0) > 0 ? '已切换；点「还原」后重新翻译生效' : '');
  } catch (err) {
    buildLanguageOptions();
    setNotice(errorText(err), { error: true });
  }
  render();
});

reviewToggle.addEventListener('click', () => {
  if (reviewToggle.getAttribute('aria-expanded') === 'true') {
    collapseReview();
    return;
  }
  reviewToggle.setAttribute('aria-expanded', 'true');
  reviewPanel.hidden = false;
  setText(reviewUndoStatus, '');
  renderReview();
  void loadReviewLog();
});

reviewUndo.addEventListener('click', async () => {
  const tabId = state.tabId;
  if (tabId == null) return;

  reviewUndo.disabled = true;
  try {
    const result = await askTab(tabId, { type: 'page.review.undo' });
    if (!result?.ok) throw new Error(result?.error || '撤销失败');
    setText(reviewUndoStatus, `已撤销 ${result.undone ?? 0} 处修正`);
    reviewUndoStatus.dataset.tone = 'ok';
    state.reviewListSig = '';
    state.reviewSig = '';
    await readPageStatus(tabId);
    await loadReviewLog();
  } catch (err) {
    setText(reviewUndoStatus, errorText(err));
    reviewUndoStatus.dataset.tone = 'danger';
    reviewUndo.disabled = false;
  }
  render();
});

openOptions.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

openDebug.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html#debug') });
});

window.addEventListener('pagehide', stopPolling);

/* -------------------------------- 启动 -------------------------------- */

(async () => {
  try {
    state.settings = await getSettings();
    buildLanguageOptions();
    buildMode();
    buildScope();
    setText(targetEl, findLanguage(state.settings.targetLang)?.name ?? state.settings.targetLang);
    debugBadge.hidden = !state.settings.debugLogEnabled;
    await refresh();
  } catch (err) {
    setNotice(errorText(err), { error: true });
    render();
  }
})();
