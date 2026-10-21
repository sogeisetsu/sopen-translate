/**
 * 工具栏弹窗：只有「翻译此页 / 还原」两个动作，真正的状态都在 content script 里。
 */

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
const translateBtn = /** @type {HTMLButtonElement} */ (pick('translate'));
const restoreBtn = /** @type {HTMLButtonElement} */ (pick('restore'));

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
    throw new Error('这个页面不支持翻译');
  }
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'status' });

  if (!status?.ok || !status.active) {
    providerEl.textContent = status?.providerCount ? '未选择默认服务' : '未配置服务';
    targetEl.textContent = '';
    translateBtn.disabled = true;
    restoreBtn.disabled = true;
    setMessage('先去设置页添加翻译服务', true);
    return;
  }

  providerEl.textContent = status.active.label;
  targetEl.textContent = `→ ${status.targetLang}`;
  setMessage('');

  const tab = await activeTab();
  if (!tab?.id) return;
  try {
    const pageStatus = await askTab(tab.id, { type: 'page.status' });
    if (pageStatus?.translated > 0) setMessage(`已翻译 ${pageStatus.translated} 段`);
  } catch {
    translateBtn.disabled = true;
    restoreBtn.disabled = true;
    setMessage('这个页面不支持翻译', true);
  }
}

translateBtn.addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  translateBtn.disabled = true;
  restoreBtn.disabled = true;
  setMessage('翻译中…');
  try {
    const result = await askTab(tab.id, { type: 'page.translate' });
    if (result?.ok) setMessage(`已翻译 ${result.translated} 段`);
    else setMessage(result?.error || '翻译失败', true);
  } catch (err) {
    setMessage(err instanceof Error ? err.message : String(err), true);
  } finally {
    translateBtn.disabled = false;
    restoreBtn.disabled = false;
  }
});

restoreBtn.addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  try {
    const result = await askTab(tab.id, { type: 'page.restore' });
    if (result?.ok) setMessage(`已还原 ${result.restored ?? 0} 段`);
    else setMessage(result?.error || '还原失败', true);
  } catch (err) {
    setMessage(err instanceof Error ? err.message : String(err), true);
  }
});

pick('open-options').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh().catch((err) => setMessage(err instanceof Error ? err.message : String(err), true));
