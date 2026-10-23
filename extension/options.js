/**
 * 设置页：预设服务管理、模型下拉、目标语言、术语表。
 *
 * 出网只发生在 background（模型列表也走 `models.list` 消息），
 * 这里只读写 `chrome.storage.local` 里的草稿。
 */

import { getSettings, mergeProviderCaches, saveSettings } from './lib/settings.js';
import { PROVIDER_PRESETS, getPreset } from './lib/provider-presets.js';
import { PROTOCOL_OPTIONS } from './lib/protocols.js';
import { resolveModelsUrl } from './lib/models.js';
import { LANGUAGES, findLanguage } from './lib/languages.js';
import { normalizeTerms } from './lib/glossary.js';

/** @typedef {import('../types').Settings} Settings */
/** @typedef {import('../types').ProviderConfig} ProviderConfig */
/** @typedef {import('../types').EnforcementMode} EnforcementMode */
/** @typedef {import('./lib/provider-presets.js').ProviderPreset} ProviderPreset */

const MODELS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

/** 三档策略的后果必须写清楚，不能只靠 `<option>` 的短标签 */
const ENFORCEMENT_HELP = {
  fallback: '漏词就整段保留原文。最保守，可能出现成片未翻译。',
  repair: '先只重翻漏词段，仍漏才保留原文。默认。',
  warn: '译文照常显示，只在结果里提示可能漏词。最流畅。',
};

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
const addPresetEl = /** @type {HTMLSelectElement} */ (pick('add-preset'));
const addBtn = /** @type {HTMLButtonElement} */ (pick('add'));
const saveBtn = /** @type {HTMLButtonElement} */ (pick('save'));
const saveMessageEl = pick('save-message');
const targetLangEl = /** @type {HTMLSelectElement} */ (pick('target-lang'));
const useBuiltinEl = /** @type {HTMLInputElement} */ (pick('use-builtin'));
const termsEl = /** @type {HTMLTextAreaElement} */ (pick('glossary-terms'));
const enforcementEl = /** @type {HTMLSelectElement} */ (pick('enforcement'));
const enforcementHelpEl = pick('enforcement-help');
const glossaryMetaEl = pick('glossary-meta');
const reviewProviderEl = /** @type {HTMLSelectElement} */ (pick('review-provider'));
const appVersionEl = pick('app-version');

const state = {
  /** @type {Settings | null} */
  draft: null,
  /** @type {Settings | null} */
  stored: null,
  /** 手动输入模型的 provider id */
  manualModel: new Set(),
  /** provider id → 一行提示 */
  modelNotice: new Map(),
};

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
    else if (key.startsWith('aria-') || key === 'role') node.setAttribute(key, String(value));
    else node[key] = value;
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

function setSaved(text, isError = false) {
  saveMessageEl.textContent = text;
  saveMessageEl.classList.toggle('is-error', isError);
}

/* -------------------------------- 校验 -------------------------------- */

/** MT 协议没有 prompt 通道：不显示模型字段，也不参与术语保护 */
const MT_PROTOCOLS = new Set(['deepl', 'microsoft-edge', 'microsoft-azure']);

/** @param {ProviderConfig} provider */
function isMtProvider(provider) {
  return MT_PROTOCOLS.has(provider.protocol);
}

/** @param {ProviderConfig} provider */
function keyOptional(provider) {
  return provider.presetId === 'custom' || getPreset(provider.presetId).requiresKey === false;
}

/**
 * 必填矩阵见计划 A6.5 / F1：
 * - 内置 LLM 预设：apiKey、model
 * - DeepL / Azure：apiKey、baseUrl（Azure 的 region 可空）
 * - Edge：只需要 baseUrl（预设自带），没有 key / model
 * - custom + LLM：protocol、baseUrl、model（apiKey 可空）
 * - custom + deepl：protocol、baseUrl、apiKey
 * @param {ProviderConfig} provider
 * @returns {string[]}
 */
function missingRequired(provider) {
  const isCustom = provider.presetId === 'custom';
  const preset = getPreset(provider.presetId);
  /** @type {string[]} */
  const missing = [];
  if (!String(provider.baseUrl ?? '').trim()) missing.push('接口地址');

  if (provider.protocol === 'microsoft-edge') return missing;
  if (provider.protocol === 'deepl' || provider.protocol === 'microsoft-azure') {
    if (!String(provider.apiKey ?? '').trim()) missing.push('API Key');
    return missing;
  }

  if (!String(provider.model ?? '').trim()) missing.push('模型');
  if (isCustom) {
    if (!provider.protocol) missing.push('协议');
  } else if (preset.requiresKey !== false && !String(provider.apiKey ?? '').trim()) {
    missing.push('API Key');
  }
  return missing;
}

/* -------------------------------- 模型 -------------------------------- */

/**
 * 缓存未过期且 URL 一致时用缓存，否则用预设建议；当前模型不在列表里也保留一项。
 * @param {ProviderConfig} provider
 * @returns {string[]}
 */
function modelChoices(provider) {
  const preset = getPreset(provider.presetId);
  const cache = provider.modelsCache;
  const url = resolveModelsUrl(provider);
  const usable =
    cache && cache.forUrl === url && Date.now() - cache.at < MODELS_CACHE_TTL ? cache.list : null;
  const base = usable && usable.length ? usable : preset.models || [];
  const choices = base.slice();
  const current = String(provider.model ?? '').trim();
  if (current && !choices.includes(current)) choices.unshift(current);
  return choices;
}

/**
 * 调 background 拉列表；失败一律安静降级，不弹红字。
 * @param {number} index
 */
async function refreshModels(index) {
  const provider = getDraft().providers[index];
  if (!provider) return;

  state.modelNotice.set(provider.id, '正在获取模型…');
  renderProviders();

  try {
    const res = await chrome.runtime.sendMessage({ type: 'models.list', provider });
    const models = Array.isArray(res?.models) ? res.models.map(String) : [];
    // 只有真正联网拿到的列表才更新缓存时间；cache / preset 都不要续期
    if (res?.from === 'network' && models.length > 0) {
      provider.modelsCache = {
        at: Date.now(),
        list: models,
        forUrl: resolveModelsUrl(provider),
      };
      if (!String(provider.model ?? '').trim()) provider.model = models[0];
    }
    state.modelNotice.set(
      provider.id,
      res?.from === 'preset'
        ? '接口没返回列表，使用预设建议'
        : res?.from === 'cache'
          ? `使用缓存：${models.length} 个模型`
          : res?.cached === false
            ? '已用草稿配置获取；保存后再刷新可缓存'
            : `已获取 ${models.length} 个模型`,
    );
  } catch {
    state.modelNotice.set(provider.id, '接口没返回列表，使用预设建议');
  }

  renderProviders();
}

/* -------------------------------- 渲染 -------------------------------- */

/**
 * @param {ProviderConfig} provider
 * @param {number} index
 * @param {ProviderPreset} preset
 * @returns {HTMLElement}
 */
function modelField(provider, index, preset) {
  const manual = state.manualModel.has(provider.id);
  const notice = state.modelNotice.get(provider.id) || '';

  /** @type {HTMLElement} */
  let control;
  if (manual) {
    control = /** @type {HTMLElement} */ (
      h('input', {
        class: 'input',
        value: provider.model || '',
        placeholder: preset.models[0] || '模型 id',
        spellcheck: false,
        dataset: { index, field: 'model' },
      })
    );
  } else {
    const choices = modelChoices(provider);
    const select = h(
      'select',
      { class: 'input', dataset: { index, field: 'model' } },
      ...choices.map((id) =>
        h('option', { value: id, text: id, selected: id === provider.model }),
      ),
    );
    if (choices.length === 0) select.append(h('option', { value: '', text: '（先刷新模型列表）' }));
    control = select;
  }

  return h(
    'div',
    { class: 'field' },
    h('span', { text: '模型' }),
    h(
      'div',
      { class: 'model-row' },
      control,
      h('button', {
        class: 'btn small',
        type: 'button',
        text: '刷新',
        dataset: { action: 'refresh-models', index },
      }),
      h('button', {
        class: 'btn small',
        type: 'button',
        text: manual ? '从列表选择' : '手动输入',
        dataset: { action: 'toggle-model', index },
      }),
    ),
    notice ? h('span', { class: 'note', text: notice }) : null,
  );
}

/**
 * @param {ProviderConfig} provider
 * @param {number} index
 * @returns {HTMLElement}
 */
function protocolField(provider, index) {
  return h(
    'label',
    { class: 'field' },
    h('span', { text: '协议' }),
    h(
      'select',
      { class: 'input', dataset: { index, field: 'protocol' } },
      ...PROTOCOL_OPTIONS.map((option) =>
        h('option', {
          value: option.id,
          text: option.label,
          selected: option.id === provider.protocol,
        }),
      ),
    ),
  );
}

/**
 * @param {ProviderConfig} provider
 * @param {number} index
 * @returns {HTMLElement}
 */
function providerCard(provider, index) {
  const preset = getPreset(provider.presetId);
  const isCustom = provider.presetId === 'custom';
  const isMt = isMtProvider(provider);
  const isEdge = provider.protocol === 'microsoft-edge';
  const isAzure = provider.protocol === 'microsoft-azure';

  const head = h(
    'div',
    { class: 'provider-head' },
    h('input', {
      class: 'input name',
      value: provider.label || preset.label,
      placeholder: '区分用的名字',
      'aria-label': '服务名称',
      dataset: { index, field: 'label' },
    }),
    h('span', { class: 'badge', text: preset.label }),
    preset.verified ? null : h('span', { class: 'badge warn', text: '未实测' }),
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

  /** @type {HTMLElement[]} */
  const fields = [];
  if (!isEdge) {
    fields.push(
      h(
        'label',
        { class: 'field' },
        h('span', { text: keyOptional(provider) ? 'API Key（可空）' : 'API Key（必填）' }),
        h('input', {
          class: 'input',
          type: 'password',
          value: provider.apiKey ?? '',
          placeholder: 'sk-...',
          autocomplete: 'off',
          spellcheck: false,
          dataset: { index, field: 'apiKey' },
        }),
      ),
    );
  }
  if (isAzure) {
    fields.push(
      h(
        'label',
        { class: 'field' },
        h('span', { text: 'Region（区域资源必填，global 可空）' }),
        h('input', {
          class: 'input',
          value: provider.region ?? '',
          placeholder: 'eastasia',
          spellcheck: false,
          dataset: { index, field: 'region' },
        }),
      ),
    );
  }
  if (!isMt) fields.push(modelField(provider, index, preset));
  if (isCustom) fields.push(protocolField(provider, index));

  /** @type {HTMLElement[]} */
  const advancedFields = [
    h(
      'label',
      { class: 'field' },
      h('span', { text: 'baseUrl' }),
      h('input', {
        class: 'input',
        value: provider.baseUrl ?? '',
        placeholder: preset.baseUrl || 'https://...',
        spellcheck: false,
        dataset: { index, field: 'baseUrl' },
      }),
    ),
  ];
  if (!isMt) {
    advancedFields.push(
      h(
        'label',
        { class: 'field' },
        h('span', { text: 'modelsUrl（留空自动推导）' }),
        h('input', {
          class: 'input',
          value: provider.modelsUrl ?? '',
          placeholder: resolveModelsUrl(provider) || 'https://.../models',
          spellcheck: false,
          dataset: { index, field: 'modelsUrl' },
        }),
      ),
    );
  }

  const advanced = h(
    'details',
    { class: 'advanced' },
    h('summary', { text: '高级：自定义接口地址' }),
    h('div', { class: 'grid' }, ...advancedFields),
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

  return h(
    'div',
    { class: 'provider', dataset: { index } },
    head,
    h('div', { class: 'grid' }, ...fields),
    advanced,
    actions,
    preset.hint ? h('p', { class: 'hint muted', text: preset.hint }) : null,
  );
}

function renderProviders() {
  const draft = getDraft();
  providersEl.replaceChildren();

  countEl.textContent = draft.providers.length ? `${draft.providers.length} 个服务` : '';

  if (draft.providers.length === 0) {
    providersEl.append(
      h('p', {
        class: 'empty',
        text: '还没有翻译服务。选一个预设，添加后填入密钥。',
      }),
    );
    return;
  }

  draft.providers.forEach((provider, index) =>
    providersEl.append(providerCard(provider, index)),
  );
}

function renderLanguages() {
  const draft = getDraft();
  targetLangEl.replaceChildren();

  const known = findLanguage(draft.targetLang);
  if (!known) {
    // 老用户的自定义目标语言：保留为只读项，不静默改成简体中文
    const current = draft.targetLang || '（空）';
    targetLangEl.append(
      h('option', {
        value: current,
        text: `当前：${current}（不在列表）`,
        selected: true,
        disabled: true,
      }),
    );
  }

  for (const language of LANGUAGES) {
    targetLangEl.append(
      h('option', {
        value: language.name,
        text: language.name,
        selected: known ? language.id === known.id : false,
      }),
    );
  }
}

function renderReviewProviders() {
  const draft = getDraft();
  const current = draft.reviewProviderId;
  const llms = draft.providers.filter((provider) => !isMtProvider(provider));

  reviewProviderEl.replaceChildren();
  reviewProviderEl.append(h('option', { value: '', text: '不审校', selected: !current }));

  for (const provider of llms) {
    const preset = getPreset(provider.presetId);
    const label = provider.label || preset.label;
    const detail = provider.model ? ` · ${provider.model}` : '';
    reviewProviderEl.append(
      h('option', {
        value: provider.id,
        text: `${label}${detail}`,
        selected: provider.id === current,
      }),
    );
  }

  if (current && !llms.some((provider) => provider.id === current)) {
    reviewProviderEl.append(
      h('option', {
        value: current,
        text: '当前：审校服务不可用',
        selected: true,
        disabled: true,
      }),
    );
  }
}

function renderForm() {
  const draft = getDraft();
  useBuiltinEl.checked = draft.glossary.useBuiltin;
  termsEl.value = draft.glossary.terms.join('\n');
  enforcementEl.value = draft.enforcement;
  updateEnforcementHelp();
  renderReviewProviders();
  appVersionEl.textContent = chrome.runtime.getManifest().version;
}

function updateEnforcementHelp() {
  enforcementHelpEl.textContent =
    ENFORCEMENT_HELP[/** @type {keyof typeof ENFORCEMENT_HELP} */ (enforcementEl.value)] || '';
}

function renderAll() {
  renderProviders();
  renderLanguages();
  renderForm();
}

/* -------------------------------- 添加服务 -------------------------------- */

function presetOptions() {
  const rest = PROVIDER_PRESETS.filter((preset) => preset.id !== 'custom');
  const custom = getPreset('custom');

  /**
   * @param {string} label
   * @param {ProviderPreset[]} presets
   */
  const group = (label, presets) =>
    h(
      'optgroup',
      { label },
      ...presets.map((preset) => h('option', { value: preset.id, text: preset.label })),
    );

  addPresetEl.append(
    group(
      '已验证',
      rest.filter((preset) => preset.verified),
    ),
    group(
      '接口未实测',
      rest.filter((preset) => !preset.verified),
    ),
    group('自定义', [custom]),
  );
}

/* -------------------------------- 交互 -------------------------------- */

/**
 * @param {HTMLElement} target
 * @returns {ProviderConfig | null}
 */
function applyField(target) {
  const index = Number(target.dataset.index);
  const field = target.dataset.field;
  if (!field || !Number.isInteger(index)) return null;
  const provider = getDraft().providers[index];
  if (!provider) return null;

  if (field === 'active') {
    if (/** @type {HTMLInputElement} */ (target).checked) {
      getDraft().activeProviderId = provider.id;
    }
    return provider;
  }

  const value = /** @type {any} */ (target).value;
  if (typeof value !== 'string') return provider;

  if (field === 'label') provider.label = value;
  else if (field === 'apiKey') provider.apiKey = value;
  else if (field === 'model') provider.model = value;
  else if (field === 'baseUrl') {
    provider.baseUrl = value;
    delete provider.modelsCache;
  } else if (field === 'modelsUrl') {
    provider.modelsUrl = value;
    delete provider.modelsCache;
  } else if (field === 'region') {
    provider.region = value;
  } else if (field === 'protocol') {
    provider.protocol = /** @type {ProviderConfig['protocol']} */ (value);
  }

  return provider;
}

providersEl.addEventListener('input', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  applyField(target);
});

providersEl.addEventListener('change', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const provider = applyField(target);
  if (!provider) return;
  const field = target.dataset.field;
  const value = /** @type {any} */ (target).value;

  // API Key 填到一定长度就自动拉一次模型列表，省掉一次手动点击；MT 没有模型列表
  if (field === 'apiKey' && !isMtProvider(provider) && String(value ?? '').trim().length > 8) {
    void refreshModels(Number(target.dataset.index));
  }
  // 切到 MT（DeepL / 微软）要隐藏模型字段，切回来要恢复
  if (field === 'protocol') renderProviders();
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
    if (draft.reviewProviderId === provider.id) {
      draft.reviewProviderId = null;
    }
    state.manualModel.delete(provider.id);
    state.modelNotice.delete(provider.id);
    renderAll();
    setSaved('已删除，记得保存');
    return;
  }

  if (button.dataset.action === 'toggle-model') {
    if (state.manualModel.has(provider.id)) state.manualModel.delete(provider.id);
    else state.manualModel.add(provider.id);
    renderProviders();
    return;
  }

  if (button.dataset.action === 'refresh-models') {
    await refreshModels(index);
    return;
  }

  if (button.dataset.action === 'test') {
    const result = /** @type {HTMLElement | null} */ (
      button.parentElement?.querySelector('.result') ?? null
    );
    if (!result) return;

    const missing = missingRequired(provider);
    if (missing.length > 0) {
      result.textContent = `缺少必填项：${missing.join('、')}`;
      result.classList.add('is-error');
      return;
    }

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

addBtn.addEventListener('click', () => {
  const preset = getPreset(addPresetEl.value);
  const draft = getDraft();
  const used = draft.providers.filter((provider) => provider.presetId === preset.id).length;
  /** @type {ProviderConfig} */
  const provider = {
    id: crypto.randomUUID(),
    presetId: preset.id,
    protocol: preset.protocol,
    label: used ? `${preset.label} ${used + 1}` : preset.label,
    baseUrl: preset.baseUrl,
    model: preset.models[0] || '',
  };
  draft.providers.push(provider);
  if (!draft.activeProviderId) draft.activeProviderId = provider.id;
  renderProviders();
  setSaved('已添加，填好字段后保存');
});

enforcementEl.addEventListener('change', updateEnforcementHelp);

saveBtn.addEventListener('click', async () => {
  const draft = getDraft();

  const invalid = draft.providers
    .map((provider) => ({ provider, missing: missingRequired(provider) }))
    .filter((entry) => entry.missing.length > 0);
  if (invalid.length > 0) {
    const detail = invalid
      .map(({ provider, missing }) => {
        const name = provider.label || getPreset(provider.presetId).label;
        return `${name}（缺 ${missing.join('、')}）`;
      })
      .join('；');
    setSaved(`还有没填完的服务：${detail}`, true);
    return;
  }

  const language = findLanguage(targetLangEl.value);
  const targetLang = language ? language.name : draft.targetLang;
  const targetLangCode = language ? language.code : draft.targetLangCode;

  saveBtn.disabled = true;
  try {
    const stored = state.stored || draft;
    state.draft = await saveSettings({
      // 只提交设置页负责的字段：displayMode 归 popup，sessionId 归 getSessionId()
      providers: mergeProviderCaches(draft.providers, stored.providers),
      activeProviderId: draft.activeProviderId,
      targetLang,
      targetLangCode,
      enforcement: /** @type {EnforcementMode} */ (enforcementEl.value),
      glossary: {
        useBuiltin: useBuiltinEl.checked,
        terms: normalizeTerms(termsEl.value.split('\n')),
      },
      reviewProviderId: reviewProviderEl.value || null,
    });
    state.stored = structuredClone(state.draft);
    renderAll();
    setSaved('已保存');
  } catch (err) {
    setSaved(`保存失败：${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    saveBtn.disabled = false;
  }
});

/* -------------------------------- 启动 -------------------------------- */

async function showGlossaryMeta() {
  try {
    const res = await fetch(chrome.runtime.getURL('lib/glossary-data.json'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const count = Number(data?.count ?? (Array.isArray(data?.terms) ? data.terms.length : 0));
    glossaryMetaEl.textContent = `内置 ${count} 条${
      data?.generatedAt ? `（${data.generatedAt}）` : ''
    }`;
  } catch {
    glossaryMetaEl.textContent = '内置词库尚未生成，先跑 npm run build:glossary';
  }
}

presetOptions();

getSettings()
  .then((settings) => {
    state.draft = structuredClone(settings);
    state.stored = structuredClone(settings);
    renderAll();
    void showGlossaryMeta();
  })
  .catch((err) =>
    setSaved(`读取设置失败：${err instanceof Error ? err.message : String(err)}`, true),
  );
