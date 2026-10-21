import { PROVIDER_TYPES, getProviderType } from './lib/providers.js';
import { getSettings, saveSettings } from './lib/settings.js';

const providersEl = document.getElementById('providers');
const countEl = document.getElementById('provider-count');
const addTypeEl = document.getElementById('add-type');
const addBtn = document.getElementById('add');
const saveBtn = document.getElementById('save');
const saveMessageEl = document.getElementById('save-message');
const targetLangEl = document.getElementById('target-lang');
const targetLangCodeEl = document.getElementById('target-lang-code');

/** @type {{ settings: object, draft: object }} */
const state = { settings: null, draft: null };

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
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
        checked: state.draft.activeProviderId === provider.id,
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
        value: provider[field.key] ?? '',
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

  const card = h(
    'div',
    { class: 'provider', dataset: { index } },
    head,
    h('div', { class: 'grid' }, ...fields),
    actions,
  );

  return card;
}

function render() {
  providersEl.replaceChildren();

  const { providers } = state.draft;
  countEl.textContent = providers.length ? `${providers.length} 个服务` : '';

  if (providers.length === 0) {
    providersEl.append(
      h('p', {
        class: 'empty',
        text: '还没有翻译服务。选一个类型，添加后填入接口地址和密钥。',
      }),
    );
  } else {
    providers.forEach((provider, index) => providersEl.append(providerCard(provider, index)));
  }

  targetLangEl.value = state.draft.targetLang || '';
  targetLangCodeEl.value = state.draft.targetLangCode || '';
}

/* -------------------------------- 交互 -------------------------------- */

providersEl.addEventListener('input', (event) => {
  const { index, field } = event.target.dataset;
  if (index == null || !field || field === 'active') return;
  const provider = state.draft.providers[Number(index)];
  if (!provider) return;
  provider[field] = event.target.value;
});

providersEl.addEventListener('change', (event) => {
  const { index, field } = event.target.dataset;
  if (field !== 'active' || index == null) return;
  state.draft.activeProviderId = state.draft.providers[Number(index)]?.id ?? null;
});

providersEl.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const index = Number(button.dataset.index);
  const provider = state.draft.providers[index];
  if (!provider) return;

  if (button.dataset.action === 'remove') {
    state.draft.providers.splice(index, 1);
    if (state.draft.activeProviderId === provider.id) {
      state.draft.activeProviderId = state.draft.providers[0]?.id ?? null;
    }
    render();
    setSaved('已删除，记得保存');
    return;
  }

  if (button.dataset.action === 'test') {
    const result = button.parentElement.querySelector('.result');
    result.textContent = '测试中…';
    result.classList.remove('is-error');
    button.disabled = true;

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'testProvider',
        config: provider,
      });
      if (!res?.ok) throw new Error(res?.error || '测试失败');
      result.textContent = `✓ ${res.result}（${res.elapsed}ms）`;
    } catch (err) {
      result.textContent = err.message;
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
  const type = getProviderType(addTypeEl.value);
  const used = state.draft.providers.filter((p) => p.type === type.type).length;
  const provider = {
    id: crypto.randomUUID(),
    type: type.type,
    label: used ? `${type.label} ${used + 1}` : type.label,
  };
  state.draft.providers.push(provider);
  if (!state.draft.activeProviderId) state.draft.activeProviderId = provider.id;
  render();
  setSaved('已添加，填好字段后保存');
});

saveBtn.addEventListener('click', async () => {
  state.draft.targetLang = targetLangEl.value.trim() || '简体中文';
  state.draft.targetLangCode = targetLangCodeEl.value.trim().toUpperCase() || 'ZH';

  saveBtn.disabled = true;
  try {
    state.settings = await saveSettings(state.draft);
    setSaved('已保存');
  } catch (err) {
    setSaved(`保存失败：${err.message}`, true);
  } finally {
    saveBtn.disabled = false;
  }
});

/* -------------------------------- 启动 -------------------------------- */

getSettings()
  .then((settings) => {
    state.settings = settings;
    state.draft = structuredClone(settings);
    render();
  })
  .catch((err) => setSaved(`读取设置失败：${err.message}`, true));
