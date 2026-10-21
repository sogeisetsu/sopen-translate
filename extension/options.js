import { PROVIDER_TYPES, getProviderType } from './lib/providers.js';
import { getSettings, saveSettings } from './lib/settings.js';

/** @typedef {import('../types').Settings} Settings */
/** @typedef {import('../types').ProviderConfig} ProviderConfig */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function pick(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`设置页缺少元素 #${id}`);
  return el;
}

const providersEl = /** @type {HTMLDivElement} */ (pick('providers'));
const countEl = pick('provider-count');
const addTypeEl = /** @type {HTMLSelectElement} */ (pick('add-type'));
const addBtn = /** @type {HTMLButtonElement} */ (pick('add'));
const saveBtn = /** @type {HTMLButtonElement} */ (pick('save'));
const saveMessageEl = pick('save-message');
const targetLangEl = /** @type {HTMLInputElement} */ (pick('target-lang'));
const targetLangCodeEl = /** @type {HTMLInputElement} */ (pick('target-lang-code'));

/** @type {{ draft: Settings | null }} */
const state = { draft: null };

/** @returns {Settings} */
function getDraft() {
  if (!state.draft) throw new Error('设置还没加载完');
  return state.draft;
}

/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...(Node | string | null)} children
 * @returns {HTMLElement}
 */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else node[key] = value;
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

function setSaved(text, isError = false) {
  saveMessageEl.textContent = text;
  saveMessageEl.classList.toggle('is-error', isError);
}

/* -------------------------------- 渲染 -------------------------------- */

/**
 * @param {ProviderConfig} provider
 * @param {number} index
 * @returns {HTMLElement}
 */
function providerCard(provider, index) {
  const type = getProviderType(provider.type);

  const head = h(
    'div',
    { class: 'provider-head' },
    h('input', {
      class: 'input name',
      value: provider.label || type.label,
      placeholder: '区分用的名字',
      dataset: { index, field: 'label' },
    }),
    h('span', { class: 'badge', text: type.label }),
    h(
      'label',
      { class: 'default-toggle' },
      h('input', {
        type: 'radio',
        name: 'active-provider',
        checked: state.draft?.activeProviderId === provider.id,
        dataset: { index, field: 'active' },
      }),
      '默认',
    ),
  );

  const fields = type.fields.map((field) =>
    h(
      'label',
      { class: 'field' },
      h('span', { text: field.label + (field.required ? '（必填）' : '') }),
      h('input', {
        class: 'input',
        type: field.secret ? 'password' : 'text',
        value: provider[/** @type {keyof ProviderConfig} */ (field.key)] ?? '',
        placeholder: field.placeholder || '',
        autocomplete: 'off',
        spellcheck: false,
        dataset: { index, field: field.key },
      }),
    ),
  );

  const result = h('span', { class: 'result' });

  const actions = h(
    'div',
    { class: 'provider-actions' },
    h('button', {
      class: 'btn',
      type: 'button',
      text: '测试',
      dataset: { action: 'test', index },
    }),
    h('button', {
      class: 'btn danger',
      type: 'button',
      text: '删除',
      dataset: { action: 'remove', index },
    }),
    result,
  );

  return h('div', { class: 'provider', dataset: { index } }, head, h('div', { class: 'grid' }, ...fields), actions);
}

function render() {
  const draft = getDraft();
  providersEl.replaceChildren();

  countEl.textContent = draft.providers.length ? `${draft.providers.length} 个服务` : '';

  if (draft.providers.length === 0) {
    providersEl.append(
      h('p', {
        class: 'empty',
        text: '还没有翻译服务。选一个类型，添加后填入接口地址和密钥。',
      }),
    );
  } else {
    draft.providers.forEach((provider, index) =>
      providersEl.append(providerCard(provider, index)),
    );
  }

  targetLangEl.value = draft.targetLang || '';
  targetLangCodeEl.value = draft.targetLangCode || '';
}

/* -------------------------------- 交互 -------------------------------- */

providersEl.addEventListener('input', (event) => {
  const target = /** @type {HTMLInputElement} */ (event.target);
  const { index, field } = target.dataset;
  if (index == null || !field || field === 'active') return;
  const provider = getDraft().providers[Number(index)];
  if (!provider) return;
  /** @type {any} */ (provider)[field] = target.value;
});

providersEl.addEventListener('change', (event) => {
  const target = /** @type {HTMLInputElement} */ (event.target);
  const { index, field } = target.dataset;
  if (field !== 'active' || index == null) return;
  const draft = getDraft();
  draft.activeProviderId = draft.providers[Number(index)]?.id ?? null;
});

providersEl.addEventListener('click', async (event) => {
  const button = /** @type {HTMLElement} */ (event.target).closest('button[data-action]');
  if (!(button instanceof HTMLButtonElement)) return;

  const index = Number(button.dataset.index);
  const draft = getDraft();
  const provider = draft.providers[index];
  if (!provider) return;

  if (button.dataset.action === 'remove') {
    draft.providers.splice(index, 1);
    if (draft.activeProviderId === provider.id) {
      draft.activeProviderId = draft.providers[0]?.id ?? null;
    }
    render();
    setSaved('已删除，记得保存');
    return;
  }

  if (button.dataset.action === 'test') {
    const result = /** @type {HTMLElement | null} */ (
      button.parentElement?.querySelector('.result') ?? null
    );
    if (!result) return;
    result.textContent = '测试中…';
    result.classList.remove('is-error');
    button.disabled = true;

    try {
      const res = await chrome.runtime.sendMessage({ type: 'testProvider', config: provider });
      if (!res?.ok) throw new Error(res?.error || '测试失败');
      result.textContent = `✓ ${res.result}（${res.elapsed}ms）`;
    } catch (err) {
      result.textContent = err instanceof Error ? err.message : String(err);
      result.classList.add('is-error');
    } finally {
      button.disabled = false;
    }
  }
});

addTypeEl.append(
  ...PROVIDER_TYPES.map((type) => h('option', { value: type.type, text: type.label })),
);

addBtn.addEventListener('click', () => {
  const type = getProviderType(/** @type {HTMLSelectElement} */ (addTypeEl).value);
  const draft = getDraft();
  const used = draft.providers.filter((p) => p.type === type.type).length;
  const provider = {
    id: crypto.randomUUID(),
    type: type.type,
    label: used ? `${type.label} ${used + 1}` : type.label,
  };
  draft.providers.push(provider);
  if (!draft.activeProviderId) draft.activeProviderId = provider.id;
  render();
  setSaved('已添加，填好字段后保存');
});

saveBtn.addEventListener('click', async () => {
  const draft = getDraft();
  draft.targetLang = targetLangEl.value.trim() || '简体中文';
  draft.targetLangCode = targetLangCodeEl.value.trim().toUpperCase() || 'ZH';

  saveBtn.disabled = true;
  try {
    state.draft = await saveSettings(draft);
    setSaved('已保存');
  } catch (err) {
    setSaved(`保存失败：${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    saveBtn.disabled = false;
  }
});

/* -------------------------------- 启动 -------------------------------- */

getSettings()
  .then((settings) => {
    state.draft = structuredClone(settings);
    render();
  })
  .catch((err) => setSaved(`读取设置失败：${err instanceof Error ? err.message : String(err)}`, true));
