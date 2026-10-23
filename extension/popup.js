/**
 * 工具栏弹窗：翻译 / 还原、展示模式、目标语言、进度。
 *
 * 真正的状态都在 content script 里；关掉弹窗不影响翻译继续，
 * 重新打开会从 `page.status` 恢复进度与「还原」。
 */

import { getSettings, saveSettings } from './lib/settings.js';
import { LANGUAGES, findLanguage } from './lib/languages.js';

/** @typedef {import('../types').Settings} Settings */
/** @typedef {import('../types').DisplayMode} DisplayMode */
/** @typedef {import('../types').TranslateScope} TranslateScope */
/** @typedef {{ translated: number, busy: boolean, mode?: DisplayMode, scope?: TranslateScope, pending?: boolean, progress?: { done: number, total: number } }} PageStatus */

const POLL_INTERVAL = 500;

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function pick(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`弹窗缺少元素 #${id}`);
  return el;
}

const providerEl = pick('provider');
const targetEl = pick('target');
const messageEl = pick('message');
const mainBtn = /** @type {HTMLButtonElement} */ (pick('main'));
const langEl = /** @type {HTMLSelectElement} */ (pick('target-lang'));
const modeButtons = /** @type {HTMLButtonElement[]} */ (
  Array.from(document.querySelectorAll('.mode button[data-mode]'))
);
const scopeButtons = /** @type {HTMLButtonElement[]} */ (
  Array.from(document.querySelectorAll('.mode button[data-scope]'))
);

const state = {
  /** @type {Settings | null} */
  settings: null,
  /** @type {PageStatus | null} */
  page: null,
  /** @type {number | null} */
  tabId: null,
  supported: true,
  hasProvider: false,
  /** @type {ReturnType<typeof setInterval> | null} */
  timer: null,
  polling: false,
};

function setMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.classList.toggle('is-error', isError);
}

/** @returns {Promise<chrome.tabs.Tab | undefined>} */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * 目标页可能不允许注入（chrome:// 等），统一转成可读提示
 * @param {number} tabId
 * @param {unknown} message
 */
async function askTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    state.supported = false;
    throw new Error('这个页面不支持翻译');
  }
}

/* -------------------------------- 渲染 -------------------------------- */

function buildLanguageOptions() {
  langEl.replaceChildren();
  const settings = state.settings;

  const known = findLanguage(settings?.targetLang);
  if (settings && !known) {
    const current = settings.targetLang || '（空）';
    langEl.append(
      new Option(`当前：${current}（不在列表）`, current, true, true),
    );
    langEl.options[0].disabled = true;
  }

  for (const language of LANGUAGES) {
    langEl.append(new Option(language.name, language.name, false, known?.id === language.id));
  }
}

function buildModeButtons() {
  const mode = state.settings?.displayMode === 'bilingual' ? 'bilingual' : 'translation';
  for (const button of modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
}

function buildScopeButtons() {
  const scope = state.settings?.translateScope === 'whole' ? 'whole' : 'viewport';
  for (const button of scopeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.scope === scope));
  }
}

function render() {
  const page = state.page;
  const busy = Boolean(page?.busy);

  if (!state.hasProvider) {
    mainBtn.disabled = true;
    mainBtn.textContent = '翻译';
    setMessage('先去设置页添加翻译服务', true);
  } else if (!state.supported) {
    mainBtn.disabled = true;
    mainBtn.textContent = '翻译';
    setMessage('这个页面不支持翻译', true);
  } else if (busy) {
    const progress = page?.progress;
    mainBtn.disabled = true;
    mainBtn.textContent =
      progress && progress.total > 0 ? `${progress.done}/${progress.total}` : '翻译中';
    setMessage(
      `翻译中${page?.mode === 'bilingual' ? '（双语）' : ''}${
        progress && progress.total > 0 ? ` ${progress.done}/${progress.total}` : ''
      }…`,
    );
  } else if ((page?.translated ?? 0) > 0) {
    mainBtn.disabled = false;
    mainBtn.textContent = '还原';
    mainBtn.dataset.action = 'restore';
    const unit = page?.mode === 'bilingual' ? '块' : '段';
    const pending = page?.pending ? '，滚动继续翻译' : '';
    setMessage(`已翻译 ${page?.translated ?? 0} ${unit}${pending}`);
  } else {
    mainBtn.disabled = false;
    mainBtn.textContent = '翻译';
    mainBtn.dataset.action = 'translate';
    setMessage(page?.pending ? '滚动后继续翻译可视区域' : '');
  }

  // 翻译中禁掉模式、范围与语言：background 每批读一次设置，
  // 中途改会让同一页前后批次用不同目标语言 / 模式 / 范围。
  for (const button of modeButtons) button.disabled = busy;
  for (const button of scopeButtons) button.disabled = busy;
  langEl.disabled = busy;
}

/* -------------------------------- 轮询 -------------------------------- */

function stopPolling() {
  if (state.timer !== null) clearInterval(state.timer);
  state.timer = null;
  state.polling = false;
}

/** @param {number} tabId */
function startPolling(tabId) {
  stopPolling();
  state.timer = setInterval(async () => {
    if (state.polling) return;
    state.polling = true;
    try {
      state.page = /** @type {PageStatus} */ (await askTab(tabId, { type: 'page.status' }));
      render();
    } catch {
      /* 页面跳走/关掉时安静结束 */
    } finally {
      state.polling = false;
    }
  }, POLL_INTERVAL);
}

/* -------------------------------- 状态 -------------------------------- */

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  state.hasProvider = Boolean(status?.ok && status.active);

  if (!state.hasProvider) {
    providerEl.textContent = status?.providerCount ? '未选择默认服务' : '未配置服务';
    targetEl.textContent = '';
    render();
    return;
  }

  providerEl.textContent = status.active.label;
  targetEl.textContent = `→ ${status.targetLang}`;

  const tab = await activeTab();
  state.tabId = tab?.id ?? null;
  if (state.tabId == null) {
    state.supported = false;
    render();
    return;
  }

  try {
    state.page = /** @type {PageStatus} */ (await askTab(state.tabId, { type: 'page.status' }));
    state.supported = true;
  } catch (err) {
    state.page = null;
    state.supported = false;
    setMessage(err instanceof Error ? err.message : String(err), true);
  }
  render();
}

/* -------------------------------- 交互 -------------------------------- */

mainBtn.addEventListener('click', async () => {
  const tabId = state.tabId;
  if (tabId == null) return;

  const action = mainBtn.dataset.action === 'restore' ? 'restore' : 'translate';
  mainBtn.disabled = true;

  if (action === 'restore') {
    try {
      const result = await askTab(tabId, { type: 'page.restore' });
      if (!result?.ok) throw new Error(result?.error || '还原失败');
      setMessage(`已还原 ${result.restored ?? 0} 处`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err), true);
    }
    try {
      state.page = /** @type {PageStatus} */ (await askTab(tabId, { type: 'page.status' }));
    } catch {
      state.page = null;
    }
    render();
    return;
  }

  setMessage('翻译中…');
  startPolling(tabId);
  try {
    const result = await askTab(tabId, { type: 'page.translate' });
    if (!result?.ok) throw new Error(result?.error || '翻译失败');
    const unit = result.translated > 0 ? `已翻译 ${result.translated} 个单元` : '没有可翻译的文本';
    setMessage(unit);
  } catch (err) {
    setMessage(err instanceof Error ? err.message : String(err), true);
  } finally {
    stopPolling();
    try {
      state.page = /** @type {PageStatus} */ (await askTab(tabId, { type: 'page.status' }));
    } catch {
      /* 忽略 */
    }
    render();
  }
});

for (const button of modeButtons) {
  button.addEventListener('click', async () => {
    const mode = /** @type {DisplayMode} */ (button.dataset.mode);
    if (!state.settings || state.settings.displayMode === mode) return;
    state.settings = await saveSettings({ displayMode: mode });
    buildModeButtons();
    if ((state.page?.translated ?? 0) > 0) {
      setMessage('已切换；点「还原」后重新翻译生效');
    }
  });
}

for (const button of scopeButtons) {
  button.addEventListener('click', async () => {
    const scope = /** @type {TranslateScope} */ (button.dataset.scope);
    if (!state.settings || state.settings.translateScope === scope) return;
    state.settings = await saveSettings({ translateScope: scope });
    buildScopeButtons();
    if ((state.page?.translated ?? 0) > 0) {
      setMessage('已切换；点「还原」后重新翻译生效');
    }
  });
}

langEl.addEventListener('change', async () => {
  const language = findLanguage(langEl.value);
  if (!language) return; // 只读的老值项
  state.settings = await saveSettings({
    targetLang: language.name,
    targetLangCode: language.code,
  });
  targetEl.textContent = `→ ${language.name}`;
  if ((state.page?.translated ?? 0) > 0) setMessage('下次翻译生效');
});

pick('open-options').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

/* -------------------------------- 启动 -------------------------------- */

(async () => {
  try {
    state.settings = await getSettings();
    buildLanguageOptions();
    buildModeButtons();
    buildScopeButtons();
    await refresh();
  } catch (err) {
    setMessage(err instanceof Error ? err.message : String(err), true);
  }
})();
