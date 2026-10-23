/**
 * 设置页：预设服务管理、模型下拉、目标语言、术语表、可选审校与本地调试日志。
 *
 * 出网只发生在 background（模型列表、测试、调试日志都走消息），
 * 这里只读写 `chrome.storage.local` 里的草稿。
 *
 * 只提交本页负责的字段：providers / activeProviderId / targetLang / targetLangCode /
 * enforcement / glossary / reviewProviderId。displayMode 归 popup，sessionId 归
 * `getSessionId()`，调试开关是即时保存、不走「保存设置」。
 */

import { getSettings, mergeProviderCaches, saveSettings } from './lib/settings.js';
import { PROVIDER_PRESETS, getPreset } from './lib/provider-presets.js';
import { PROTOCOL_OPTIONS } from './lib/protocols.js';
import { resolveModelsUrl } from './lib/models.js';
import { LANGUAGES, findLanguage, rivaPair, builtinLang } from './lib/languages.js';
import { normalizeTerms } from './lib/glossary.js';
import { buildDebugExport, formatDebugLine } from './lib/debug-log.js';
import { initTips } from './lib/ui-tip.js';

/** @typedef {import('../types').Settings} Settings */
/** @typedef {import('../types').ProviderConfig} ProviderConfig */
/** @typedef {import('../types').EnforcementMode} EnforcementMode */
/** @typedef {import('../types').DebugLogEntry} DebugLogEntry */
/** @typedef {import('./lib/provider-presets.js').ProviderPreset} ProviderPreset */

const MODELS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

/**
 * Google 2 的公共测试 key 不在仓库里。点击「使用公共测试 key」时从 KISS Translator
 * 的公开源码临时读取，填进当前草稿；不落盘、不写进仓库，key 失效时回退为手动填写。
 */
const GOOGLE_PUBLIC_KEY_SOURCES = [
  'https://raw.githubusercontent.com/fishjar/kiss-translator/dev/src/builtin-plugins/presets.js',
  'https://raw.githubusercontent.com/fishjar/kiss-translator/dev/src/config/api.js',
];
/** @type {string | null} */
let publicGoogleKeyCache = null;

/** @returns {Promise<string>} */
async function fetchPublicGoogleKey() {
  if (publicGoogleKeyCache) return publicGoogleKeyCache;
  for (const source of GOOGLE_PUBLIC_KEY_SOURCES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(source, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) continue;
      const text = await res.text();
      const match = text.match(
        /\[OPT_TRANS_GOOGLE_2\][\s\S]{0,400}?key:\s*["']([^"']+)["']/,
      );
      const key = String(match?.[1] ?? '').trim();
      if (!/^AIza[\w-]{20,}$/.test(key)) continue;
      publicGoogleKeyCache = key;
      return key;
    } catch {
      /* 换下一个来源 */
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('公共测试 key 获取失败');
}

/** 文件直开 / 非扩展上下文没有 chrome.storage.local，整页降级而不是抛原始异常 */
const storageAvailable = Boolean(globalThis.chrome?.storage?.local);

/** 三档策略的后果必须写清楚，不能只靠分段按钮的短标签 */
const ENFORCEMENT_HELP = {
  fallback: '保留原文：漏词就整段回退原文，最保守，可能出现成片未翻译。',
  repair: '自动补翻：只重翻漏词段，仍漏才回退原文。默认。',
  warn: '只提示：译文照常显示，只在结果里提示可能漏词。',
};

/** 缺哪个文案，就标哪个字段 */
const FIELD_BY_LABEL = {
  接口地址: 'baseUrl',
  'API Key': 'apiKey',
  模型: 'model',
  协议: 'protocol',
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
const presetHintEl = pick('preset-hint');
const addBtn = /** @type {HTMLButtonElement} */ (pick('add'));
const saveBarEl = pick('save-bar');
const saveBtn = /** @type {HTMLButtonElement} */ (pick('save'));
const saveMessageEl = pick('save-message');
const envWarningEl = pick('env-warning');
const targetLangEl = /** @type {HTMLSelectElement} */ (pick('target-lang'));
const targetLangHintEl = pick('target-lang-hint');
const useBuiltinEl = /** @type {HTMLInputElement} */ (pick('use-builtin'));
const termsEl = /** @type {HTMLTextAreaElement} */ (pick('glossary-terms'));
const enforcementInputs = /** @type {HTMLInputElement[]} */ (
  Array.from(document.querySelectorAll('input[name="enforcement"]'))
);
const enforcementHelpEl = pick('enforcement-help');
const glossaryMetaEl = pick('glossary-meta');
const reviewProviderEl = /** @type {HTMLSelectElement} */ (pick('review-provider'));
const appVersionEl = pick('app-version');
const appVersionAboutEl = pick('app-version-about');

const debugCard = pick('debug');
const debugEnabledEl = /** @type {HTMLInputElement} */ (pick('debug-enabled'));
const debugSamplesEl = /** @type {HTMLInputElement} */ (pick('debug-samples'));
const debugNoteEl = /** @type {HTMLInputElement} */ (pick('debug-note'));
const debugNoteAddBtn = /** @type {HTMLButtonElement} */ (pick('debug-note-add'));
const debugListEl = /** @type {HTMLUListElement} */ (pick('debug-list'));
const debugCountEl = pick('debug-count');
const debugStatusEl = pick('debug-status');
const debugCopyBtn = /** @type {HTMLButtonElement} */ (pick('debug-copy'));
const debugExportBtn = /** @type {HTMLButtonElement} */ (pick('debug-export'));
const debugClearBtn = /** @type {HTMLButtonElement} */ (pick('debug-clear'));
const debugRefreshBtn = /** @type {HTMLButtonElement} */ (pick('debug-refresh'));

if (enforcementInputs.length !== 3) throw new Error('设置页缺少漏词策略选项');

const state = {
  /** @type {Settings | null} */
  draft: null,
  /** @type {Settings | null} */
  stored: null,
  /** 手动输入模型的 provider id */
  manualModel: new Set(),
  /** provider id → 一行提示 */
  modelNotice: new Map(),
  dirty: false,
  saving: false,
  /** @type {DebugLogEntry[]} */
  debugEntries: [],
  clearArmed: false,
  clearTimer: 0,
};

/** @returns {Settings} */
function getDraft() {
  if (!state.draft) throw new Error('设置还没加载完');
  return state.draft;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errText(err) {
  return err instanceof Error ? err.message : String(err);
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
    else if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role') {
      node.setAttribute(key, String(value));
    } else node[key] = value;
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

/**
 * 说明按钮；气泡由 `initTips()` 绑定。
 * @param {string} text
 * @param {string} label
 * @returns {HTMLButtonElement}
 */
function tipButton(text, label) {
  return /** @type {HTMLButtonElement} */ (
    h(
      'button',
      {
        class: 'info-tip',
        type: 'button',
        'aria-label': label,
        'data-tip': text,
      },
      h('span', { 'aria-hidden': 'true', text: 'i' }),
    )
  );
}

/**
 * 标签 + 控件 + 提示，tip 按钮放在 label 外，避免点提示时触发 label。
 * @param {Object} options
 * @param {string} options.id
 * @param {string} options.label
 * @param {HTMLElement} options.control
 * @param {string} [options.tip]
 * @param {string} [options.tipLabel]
 * @param {string} [options.hint]
 * @param {string} [options.className]
 * @returns {HTMLElement}
 */
function fieldGroup({ id, label, control, tip, tipLabel, hint, className }) {
  const head = h(
    'div',
    { class: 'field-head' },
    h('label', { htmlFor: id, text: label }),
    tip ? tipButton(tip, tipLabel || `${label}说明`) : null,
  );
  return h(
    'div',
    { class: `field ${className || ''}`.trim() },
    head,
    control,
    hint ? h('p', { class: 'field-hint', text: hint }) : null,
  );
}

/* ------------------------------ 保存状态 ------------------------------ */

/**
 * @param {'idle' | 'dirty' | 'saving' | 'saved' | 'error'} kind
 * @param {string} text
 */
function setSaveStatus(kind, text) {
  saveBarEl.dataset.state = kind;
  saveMessageEl.textContent = text;
}

/**
 * 标记有未保存的改动；保存中不打扰。
 * @param {string} [message]
 */
function markDirty(message = '有未保存的改动') {
  if (state.saving || !state.draft) return;
  state.dirty = true;
  setSaveStatus('dirty', message);
}

/** 非扩展上下文：给一条友好横幅并禁用所有需要 chrome.storage 的操作 */
function showEnvironmentWarning() {
  envWarningEl.hidden = false;
  countEl.textContent = '';
  providersEl.replaceChildren(
    h('p', { class: 'empty', text: '请在扩展环境中打开本页后再配置翻译服务。' }),
  );

  targetLangEl.replaceChildren(h('option', { value: '', text: '需要扩展环境' }));
  reviewProviderEl.replaceChildren(h('option', { value: '', text: '需要扩展环境' }));
  targetLangEl.disabled = true;
  reviewProviderEl.disabled = true;
  useBuiltinEl.disabled = true;
  termsEl.disabled = true;
  for (const input of enforcementInputs) input.disabled = true;
  addPresetEl.disabled = true;
  addBtn.disabled = true;
  saveBtn.disabled = true;
  saveBtn.title = '需要扩展环境';

  debugEnabledEl.disabled = true;
  debugSamplesEl.disabled = true;
  debugNoteEl.disabled = true;
  debugNoteAddBtn.disabled = true;
  debugCopyBtn.disabled = true;
  debugExportBtn.disabled = true;
  debugClearBtn.disabled = true;
  debugRefreshBtn.disabled = true;
  debugListEl.replaceChildren(
    h('li', { class: 'empty', text: '请在扩展环境中打开本页后查看日志。' }),
  );
  debugCountEl.textContent = '';
  debugStatusEl.textContent = '';
  glossaryMetaEl.textContent = '';
  appVersionEl.textContent = '—';
  appVersionAboutEl.textContent = '—';
  const versionPill = appVersionEl.closest('.version-pill');
  if (versionPill instanceof HTMLElement) versionPill.hidden = true;

  setSaveStatus('idle', '需要扩展环境');
}

/* -------------------------------- 校验 -------------------------------- */

/** MT 协议没有 prompt 通道：不显示模型字段，也不参与术语保护 / 审校 */
const MT_PROTOCOLS = new Set([
  'deepl',
  'microsoft-edge',
  'microsoft-azure',
  'google-free',
  'google-pa',
  'nvidia-riva',
  'chrome-builtin',
]);

/** @param {ProviderConfig} provider */
function isMtProvider(provider) {
  return MT_PROTOCOLS.has(provider.protocol);
}

/** @param {ProviderConfig} provider */
function keyOptional(provider) {
  return provider.presetId === 'custom' || getPreset(provider.presetId).requiresKey === false;
}

/**
 * 必填矩阵：
 * - 内置 LLM 预设：apiKey、model
 * - DeepL / Azure：apiKey、baseUrl（Azure 的 region 可空）
 * - Edge / Google 免费：只需要 baseUrl
 * - NVIDIA Riva：apiKey、baseUrl（模型固定）
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
  // 端侧内置翻译没有接口地址、key、模型；只需要语言包
  if (provider.protocol === 'chrome-builtin') return missing;
  if (!String(provider.baseUrl ?? '').trim()) missing.push('接口地址');

  if (provider.protocol === 'microsoft-edge' || provider.protocol === 'google-free') return missing;

  if (provider.protocol === 'nvidia-riva') {
    if (!String(provider.apiKey ?? '').trim()) missing.push('API Key');
    return missing;
  }

  if (provider.protocol === 'google-pa') {
    if (!String(provider.apiKey ?? '').trim()) missing.push('API Key');
    return missing;
  }

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

/** 清掉上一次保存失败留下的行内错误 */
function resetValidation() {
  for (const control of providersEl.querySelectorAll('.is-invalid')) {
    control.classList.remove('is-invalid');
    control.removeAttribute('aria-invalid');
  }
  for (const error of providersEl.querySelectorAll('.field-error')) error.remove();
  for (const card of providersEl.querySelectorAll('.provider.has-error')) {
    card.classList.remove('has-error');
  }
}

/**
 * 在具体字段旁边标出必填错误；接口地址 / 协议藏在高级区时自动展开。
 * @param {number} index
 * @param {string[]} missing
 */
function showValidation(index, missing) {
  const card = /** @type {HTMLElement | null} */ (
    providersEl.querySelector(`.provider[data-index="${index}"]`)
  );
  if (!card) return;
  card.classList.add('has-error');

  for (const label of missing) {
    const field = FIELD_BY_LABEL[/** @type {keyof typeof FIELD_BY_LABEL} */ (label)];
    if (!field) continue;
    const control = /** @type {HTMLElement | null} */ (
      card.querySelector(`[data-field="${field}"]`)
    );
    if (!control) continue;
    const fieldEl = control.closest('.field');
    if (!fieldEl) continue;
    control.classList.add('is-invalid');
    control.setAttribute('aria-invalid', 'true');
    if (!fieldEl.querySelector('.field-error')) {
      fieldEl.append(h('span', { class: 'field-error', text: '这一项必填' }));
    }
    if (field === 'baseUrl' || field === 'protocol') {
      const details = card.querySelector('details.advanced');
      if (details instanceof HTMLDetailsElement) details.open = true;
    }
  }
}

/**
 * @param {unknown} target
 */
function clearFieldError(target) {
  if (!(target instanceof HTMLElement)) return;
  target.classList.remove('is-invalid');
  target.removeAttribute('aria-invalid');
  const fieldEl = target.closest('.field');
  if (fieldEl) {
    fieldEl.querySelector('.field-error')?.remove();
    fieldEl.classList.remove('has-error');
  }
  const card = target.closest('.provider');
  if (card && !card.querySelector('.is-invalid')) card.classList.remove('has-error');
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
  if (!storageAvailable) return;
  const provider = getDraft().providers[index];
  if (!provider) return;

  state.modelNotice.set(provider.id, '正在获取模型…');
  renderProviders();

  const before = provider.model;
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

  if (provider.model !== before) markDirty('模型已更新，记得保存');
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
  const id = `p-${index}-model`;

  /** @type {HTMLElement} */
  let control;
  if (manual) {
    control = h('input', {
      class: 'input',
      id,
      value: provider.model || '',
      placeholder: preset.models[0] || '模型 id',
      spellcheck: false,
      dataset: { index, field: 'model' },
    });
  } else {
    const choices = modelChoices(provider);
    const select = h(
      'select',
      { class: 'input', id, dataset: { index, field: 'model' } },
      ...choices.map((model) =>
        h('option', { value: model, text: model, selected: model === provider.model }),
      ),
    );
    if (choices.length === 0) {
      select.append(h('option', { value: '', text: '（刷新或手动输入）' }));
    } else if (!String(provider.model ?? '').trim()) {
      select.prepend(h('option', { value: '', text: '选择模型…', selected: true }));
    }
    control = select;
  }

  const row = h(
    'div',
    { class: 'input-row model-row' },
    control,
    h('button', {
      class: 'btn small',
      type: 'button',
      text: '刷新',
      dataset: { action: 'refresh-models', index },
    }),
    h('button', {
      class: 'btn small ghost',
      type: 'button',
      text: manual ? '从列表选择' : '手动输入',
      dataset: { action: 'toggle-model', index },
    }),
    tipButton(
      '拉取失败、超时或接口不返回列表时，会自动回退到预设建议，不会弹红字。也可以直接「手动输入」模型 id。',
      '刷新失败的降级说明',
    ),
  );

  return fieldGroup({
    id,
    label: '模型',
    control: row,
    tip: '有的服务不提供模型列表（例如 DeepL、微软、Riva），或列表接口需要额外权限，这时下拉里只有预设建议。',
    tipLabel: '为什么没有模型列表',
    hint: notice,
  });
}

/**
 * @param {ProviderConfig} provider
 * @param {number} index
 * @returns {HTMLElement}
 */
function protocolField(provider, index) {
  const id = `p-${index}-protocol`;
  const control = h(
    'select',
    { class: 'input', id, dataset: { index, field: 'protocol' } },
    ...PROTOCOL_OPTIONS.map((option) =>
      h('option', {
        value: option.id,
        text: option.label,
        selected: option.id === provider.protocol,
      }),
    ),
  );
  return fieldGroup({
    id,
    label: '协议',
    control,
    tip: 'Chat Completions 覆盖绝大多数 OpenAI 兼容接口；只有服务端明确提供 /v1/responses 时才选 Responses。Anthropic 与 Gemini 用各自的专用协议。',
    tipLabel: '协议怎么选',
    hint: '换协议会改变请求路径与鉴权方式；不确定就保持 Chat Completions。',
  });
}

/**
 * NVIDIA Riva 的源语言选择 + 语言对预览。
 * @param {ProviderConfig} provider
 * @param {number} index
 * @returns {HTMLElement}
 */
function rivaSourceField(provider, index) {
  const id = `p-${index}-source`;
  const current = provider.sourceLang || 'en';
  const known = LANGUAGES.some((language) => language.id === current);
  const options = LANGUAGES.map((language) =>
    h('option', {
      value: language.id,
      text: language.name,
      selected: language.id === current,
    }),
  );
  if (!known) {
    options.unshift(
      h('option', {
        value: current,
        text: `当前：${current}（不在列表）`,
        selected: true,
        disabled: true,
      }),
    );
  }

  const select = h(
    'select',
    { class: 'input', id, dataset: { index, field: 'sourceLang' } },
    ...options,
  );
  const wrapper = fieldGroup({
    id,
    label: '源语言',
    control: select,
    tip: 'Riva 的 system 只接受 en-zh-cn 这样的语言对，不注入术语，也不会按行拆分。源语言选错，译文会直接跑偏。',
    tipLabel: 'Riva 语言对与限制',
  });
  wrapper.append(
    h('p', {
      class: 'field-hint riva-pair',
      dataset: { rivaPreview: provider.id },
      text: `语言对：${rivaPair(current, currentTarget().code)}`,
    }),
  );
  return wrapper;
}

/**
 * Chrome 内置翻译的源语言 + 语言对预览。
 * @param {ProviderConfig} provider
 * @param {number} index
 * @returns {HTMLElement}
 */
function builtinSourceField(provider, index) {
  const id = `p-${index}-source`;
  const current = provider.sourceLang || 'en';
  const known = LANGUAGES.some((language) => language.id === current);
  const options = LANGUAGES.map((language) =>
    h('option', {
      value: language.id,
      text: language.name,
      selected: language.id === current,
    }),
  );
  if (!known) {
    options.unshift(
      h('option', {
        value: current,
        text: `当前：${current}（不在列表）`,
        selected: true,
        disabled: true,
      }),
    );
  }

  const wrapper = fieldGroup({
    id,
    label: '源语言',
    control: h(
      'select',
      { class: 'input', id, dataset: { index, field: 'sourceLang' } },
      ...options,
    ),
    tip: '端侧模型按语言对加载：源语言选错，译文会跑偏。首次使用某个语言对时，要点下面的「准备语言包」下载一次。',
    tipLabel: '内置翻译的语言对',
    hint: '模型在本机运行，页面文本不会发到任何服务器。',
  });
  wrapper.append(
    h('p', {
      class: 'field-hint builtin-pair',
      dataset: { builtinPreview: provider.id },
      text: `语言对：${builtinLang(current)} → ${builtinLang(currentTarget().code)}`,
    }),
  );
  return wrapper;
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
  const isRiva = provider.presetId === 'nvidia-riva';
  const isBuiltin = provider.protocol === 'chrome-builtin';
  const isGooglePa = provider.protocol === 'google-pa';
  const isGoogleFree = provider.protocol === 'google-free';
  const hideKey = isEdge || provider.protocol === 'google-free' || isBuiltin;
  const active = getDraft().activeProviderId === provider.id;
  const displayName = provider.label || preset.label;

  const head = h(
    'div',
    { class: 'provider-head' },
    h('input', {
      class: 'input provider-name',
      id: `p-${index}-label`,
      value: displayName,
      placeholder: '给这个服务起个名字',
      spellcheck: false,
      'aria-label': '服务名称',
      dataset: { index, field: 'label' },
    }),
    h(
      'div',
      { class: 'provider-meta' },
      h('span', { class: 'badge', text: preset.label }),
      isCustom
        ? null
        : preset.verified
          ? h('span', { class: 'badge ok', text: '已验证' })
          : h('span', { class: 'badge warn', text: '接口未实测' }),
      isMt ? h('span', { class: 'badge', text: '无术语' }) : null,
    ),
    h(
      'label',
      { class: 'default-pick' },
      h('input', {
        type: 'radio',
        name: 'active-provider',
        checked: active,
        'aria-label': `把 ${displayName} 设为默认服务`,
        dataset: { index, field: 'active' },
      }),
      h('span', { text: '默认' }),
    ),
  );

  /** @type {HTMLElement[]} */
  const fields = [];

  if (!hideKey) {
    const keyId = `p-${index}-key`;
    const keyInput = h('input', {
      class: 'input',
      id: keyId,
      type: 'password',
      value: provider.apiKey ?? '',
      placeholder: '粘贴 API Key',
      autocomplete: 'off',
      spellcheck: false,
      dataset: { index, field: 'apiKey' },
    });
    const keyToggle = h('button', {
      class: 'btn small ghost',
      type: 'button',
      text: '显示',
      'aria-pressed': 'false',
      'aria-controls': keyId,
      'aria-label': '显示或隐藏 API Key',
      dataset: { action: 'toggle-key', index },
    });
    fields.push(
      fieldGroup({
        id: keyId,
        label: keyOptional(provider) ? 'API Key（可空）' : 'API Key（必填）',
        control: h('div', { class: 'input-row' }, keyInput, keyToggle),
        tip: '到服务商控制台的「API Keys」页面新建一个，粘贴到这里。密钥只写本机 chrome.storage.local；本地 Ollama / One-API 这类服务可以不填。',
        tipLabel: '密钥从哪里来、存在哪',
      }),
    );
  }

  if (isAzure) {
    const regionId = `p-${index}-region`;
    fields.push(
      fieldGroup({
        id: regionId,
        label: 'Region',
        control: h('input', {
          class: 'input',
          id: regionId,
          value: provider.region ?? '',
          placeholder: 'eastasia',
          spellcheck: false,
          dataset: { index, field: 'region' },
        }),
        hint: '区域资源必填，global 资源可以留空。',
      }),
    );
  }

  if (!isMt) fields.push(modelField(provider, index, preset));
  if (isRiva) fields.push(rivaSourceField(provider, index));
  if (isBuiltin) fields.push(builtinSourceField(provider, index));

  /** @type {HTMLElement[]} */
  const advancedFields = [];
  if (!isBuiltin) {
    advancedFields.push(
      fieldGroup({
        id: `p-${index}-base`,
        label: 'baseUrl',
        control: h('input', {
          class: 'input',
          id: `p-${index}-base`,
          value: provider.baseUrl ?? '',
          placeholder: preset.baseUrl || 'https://...',
          spellcheck: false,
          dataset: { index, field: 'baseUrl' },
        }),
        tip: '接口根地址，不要带 /chat/completions。改地址会让模型缓存自动失效；本地代理记得连端口一起填。',
        tipLabel: 'baseUrl 是什么',
        hint: preset.baseUrl ? `预设：${preset.baseUrl}` : '',
      }),
    );
  }

  if (!isMt) {
    advancedFields.push(
      fieldGroup({
        id: `p-${index}-models`,
        label: 'modelsUrl',
        control: h('input', {
          class: 'input',
          id: `p-${index}-models`,
          value: provider.modelsUrl ?? '',
          placeholder: resolveModelsUrl(provider) || 'https://.../models',
          spellcheck: false,
          dataset: { index, field: 'modelsUrl' },
        }),
        tip: '留空时按 baseUrl + /models 推导。像 OpenCode Go 这种模型地址与接口地址不同的服务，用预设自带的地址即可。',
        tipLabel: 'modelsUrl 什么时候要填',
        hint: resolveModelsUrl(provider) ? `当前推导：${resolveModelsUrl(provider)}` : '',
      }),
    );
  }

  if (isCustom) advancedFields.push(protocolField(provider, index));

  const advanced = advancedFields.length
    ? h(
        'details',
        { class: 'advanced', open: isCustom },
        h('summary', {
          text: isCustom ? '高级：接口地址与协议' : '高级：自定义接口地址',
        }),
        h('div', { class: 'grid' }, ...advancedFields),
      )
    : null;

  const result = h('span', { class: 'result', role: 'status', 'aria-live': 'polite' });
  const actions = h(
    'div',
    { class: 'provider-actions' },
    isBuiltin
      ? h('button', {
          class: 'btn small',
          type: 'button',
          text: '准备语言包',
          dataset: { action: 'prepare-builtin', index },
        })
      : null,
    isGooglePa
      ? h('button', {
          class: 'btn small ghost',
          type: 'button',
          text: '使用公共测试 key',
          dataset: { action: 'fill-google-key', index },
        })
      : null,
    h('button', {
      class: 'btn small',
      type: 'button',
      text: '测试',
      dataset: { action: 'test', index },
    }),
    h('button', {
      class: 'btn small danger',
      type: 'button',
      text: '删除',
      dataset: { action: 'remove', index },
    }),
    result,
  );

  const rivaNote = isRiva
    ? h('p', {
        class: 'provider-note',
        text: 'Riva 模型固定；不支持术语注入与 JSON 输出；一次只发 1 段，长页面会明显变慢。',
      })
    : null;
  const builtinNote = isBuiltin
    ? h('p', {
        class: 'provider-note',
        text: '端侧模型：页面文本不出本机。首次使用某个语言对时，先点「准备语言包」完成一次下载。',
      })
    : null;
  const googlePaNote = isGooglePa
    ? h('p', {
        class: 'provider-note',
        text: 'Google 2 走 translate-pa 批量接口，需要 X-Goog-API-Key；可点「使用公共测试 key」临时填入（来自 KISS Translator 公开源码，可能随时失效）。Google 1 是无需 key 的单条网页接口，容易被 429。',
      })
    : null;
  const googleFreeNote = isGoogleFree
    ? h('p', {
        class: 'provider-note',
        text: 'Google 1 是无需 key 的单条网页接口，一次一个 q，容易被 429；需要稳定批量请改用 Google 2（translate-pa）。',
      })
    : null;

  return h(
    'div',
    { class: 'provider', dataset: { index, active: active ? 'true' : 'false' } },
    head,
    fields.length ? h('div', { class: 'grid' }, ...fields) : null,
    rivaNote,
    builtinNote,
    googlePaNote,
    googleFreeNote,
    advanced,
    actions,
    preset.hint ? h('p', { class: 'provider-hint', text: preset.hint }) : null,
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
        text: '还没有翻译服务。在下面选一个预设，添加后填入密钥。',
      }),
    );
  } else {
    draft.providers.forEach((provider, index) =>
      providersEl.append(providerCard(provider, index)),
    );
  }

  // 动态卡片里的提示按钮需要在每次重绘后重新绑定
  initTips(document);
}

function currentTarget() {
  const draft = getDraft();
  const language = findLanguage(targetLangEl.value);
  if (language) return { name: language.name, code: language.code };
  return { name: draft.targetLang, code: draft.targetLangCode };
}

function updateTargetHint() {
  const draft = getDraft();
  const language = findLanguage(targetLangEl.value);
  targetLangHintEl.textContent = language
    ? `保存为「${language.name} / ${language.code}」；需要语言代码的服务会自动换成自己的写法。`
    : `当前值「${draft.targetLang || '（空）'}」不在列表里，保存时保持原样；部分服务可能无法识别。`;
}

function updateRivaPreviews() {
  const draft = getDraft();
  const targetCode = currentTarget().code;
  for (const node of providersEl.querySelectorAll('[data-riva-preview]')) {
    if (!(node instanceof HTMLElement)) continue;
    const provider = draft.providers.find((item) => item.id === node.dataset.rivaPreview);
    if (!provider) continue;
    node.textContent = `语言对：${rivaPair(provider.sourceLang || 'en', targetCode)}`;
  }
  for (const node of providersEl.querySelectorAll('[data-builtin-preview]')) {
    if (!(node instanceof HTMLElement)) continue;
    const provider = draft.providers.find((item) => item.id === node.dataset.builtinPreview);
    if (!provider) continue;
    node.textContent = `语言对：${builtinLang(provider.sourceLang || 'en')} → ${builtinLang(targetCode)}`;
  }
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

/** @returns {EnforcementMode} */
function getEnforcement() {
  const checked = enforcementInputs.find((input) => input.checked);
  return /** @type {EnforcementMode} */ (checked?.value || 'repair');
}

/** @param {string} mode */
function setEnforcement(mode) {
  for (const input of enforcementInputs) input.checked = input.value === mode;
}

function updateEnforcementHelp() {
  enforcementHelpEl.textContent = ENFORCEMENT_HELP[getEnforcement()] || '';
}

function renderDebugToggles() {
  const draft = getDraft();
  debugEnabledEl.checked = draft.debugLogEnabled;
  debugSamplesEl.checked = draft.debugLogSamples;
}

function renderForm() {
  const draft = getDraft();
  useBuiltinEl.checked = draft.glossary.useBuiltin;
  termsEl.value = draft.glossary.terms.join('\n');
  setEnforcement(draft.enforcement);
  updateEnforcementHelp();
  renderReviewProviders();
  renderDebugToggles();
  renderDebugList();
  const version = chrome.runtime.getManifest().version;
  appVersionEl.textContent = version;
  appVersionAboutEl.textContent = version;
}

function renderAll() {
  renderProviders();
  renderLanguages();
  renderForm();
  updateTargetHint();
  updateRivaPreviews();
}

/* -------------------------------- 调试日志 -------------------------------- */

/**
 * @param {string} text
 * @param {'ok' | 'warn' | 'error' | 'info'} [tone]
 */
function setDebugStatus(text, tone = 'info') {
  debugStatusEl.textContent = text;
  debugStatusEl.dataset.tone = tone;
}

function renderDebugList() {
  const entries = state.debugEntries;
  debugCountEl.textContent = entries.length ? `${entries.length} 条` : '';
  debugListEl.replaceChildren();

  if (entries.length === 0) {
    debugListEl.append(
      h('li', {
        class: 'empty',
        text: state.draft?.debugLogEnabled
          ? '日志还是空的。去翻一个页面，回来点「刷新」。'
          : '调试日志已关闭。开启上面的开关后，翻译与错误才会记录在这里。',
      }),
    );
  } else {
    // 最新在上，和“最近 50 条”的阅读顺序一致
    for (const entry of entries.slice().reverse()) {
      debugListEl.append(
        h(
          'li',
          { class: 'log-line', dataset: { level: entry.level } },
          h('code', { text: formatDebugLine(entry) }),
        ),
      );
    }
  }

  const hasEntries = entries.length > 0;
  if (!hasEntries && state.clearArmed) resetClearButton();
  debugCopyBtn.disabled = !hasEntries;
  debugExportBtn.disabled = !hasEntries;
  debugClearBtn.disabled = !hasEntries;
}

async function refreshDebugLog() {
  if (!storageAvailable) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'debug.get', limit: 50 });
    state.debugEntries = Array.isArray(res?.entries)
      ? /** @type {DebugLogEntry[]} */ (res.entries)
      : [];
    renderDebugList();
  } catch (err) {
    state.debugEntries = [];
    renderDebugList();
    setDebugStatus(`读取日志失败：${errText(err)}`, 'error');
  }
}

/**
 * 两个调试开关即时落盘，不等底部「保存设置」；底部保存仍带上当前值。
 * @param {'debugLogEnabled' | 'debugLogSamples'} field
 * @param {boolean} value
 */
async function persistDebugFlag(field, value) {
  if (!storageAvailable || !state.draft) return;
  const input = field === 'debugLogEnabled' ? debugEnabledEl : debugSamplesEl;
  input.disabled = true;
  const event = field === 'debugLogEnabled' ? 'options.debug.toggle' : 'options.debug.samples';

  /** 写一条开关日志；关闭调试时必须在落盘前发，否则后台会按已关闭丢弃 */
  const logToggle = async () => {
    try {
      await chrome.runtime.sendMessage({
        type: 'debug.log',
        level: 'info',
        event,
        source: 'options',
        message: value ? 'on' : 'off',
      });
    } catch {
      /* 日志写失败不影响开关本身 */
    }
  };

  try {
    if (!value) await logToggle();
    const next = await saveSettings({ [field]: value });
    if (!state.stored) state.stored = structuredClone(next);
    state.draft[field] = next[field];
    state.stored[field] = next[field];

    setDebugStatus(
      field === 'debugLogEnabled'
        ? value
          ? '调试日志已开启，立即生效'
          : '调试日志已关闭'
        : value
          ? '会记录翻译样本（含页面文本）'
          : '不再记录翻译样本',
      field === 'debugLogSamples' && value ? 'warn' : 'ok',
    );

    if (value) await logToggle();
    await refreshDebugLog();
  } catch (err) {
    state.draft[field] = !value;
    input.checked = !value;
    setDebugStatus(`保存失败：${errText(err)}`, 'error');
  } finally {
    input.disabled = false;
  }
}

/** @param {string} text @returns {Promise<boolean>} */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到 textarea 兜底 */
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 导出文件名用的本地时间：YYYYMMDD-HHmmss */
function exportStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function copyLog() {
  if (state.debugEntries.length === 0) {
    setDebugStatus('还没有日志可复制', 'warn');
    return;
  }
  const text = state.debugEntries
    .slice()
    .reverse()
    .map(formatDebugLine)
    .join('\n');
  const ok = await copyText(text);
  setDebugStatus(ok ? '日志已复制' : '复制失败，请手动选择日志', ok ? 'ok' : 'error');
}

async function exportLog() {
  if (!storageAvailable) return;
  setDebugStatus('正在准备导出…', 'info');
  /** @type {DebugLogEntry[]} */
  let entries = state.debugEntries;
  try {
    // 列表只展示 50 条，导出尽量给全（后台上限 500 条 / 1MB）
    const res = await chrome.runtime.sendMessage({ type: 'debug.get', limit: 500 });
    if (Array.isArray(res?.entries) && res.entries.length > 0) {
      entries = /** @type {DebugLogEntry[]} */ (res.entries);
    }
  } catch {
    /* 用当前列表兜底 */
  }

  if (entries.length === 0) {
    setDebugStatus('还没有日志可导出', 'warn');
    return;
  }

  const payload = buildDebugExport({
    entries,
    settings: state.stored ?? state.draft,
    appVersion: chrome.runtime.getManifest().version,
    ua: navigator.userAgent,
    samples: Boolean(state.draft?.debugLogSamples),
    now: Date.now(),
  });

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `sopen-debug-${exportStamp()}.json`;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setDebugStatus(`已导出 ${entries.length} 条日志`, 'ok');
}

function resetClearButton() {
  state.clearArmed = false;
  if (state.clearTimer) {
    window.clearTimeout(state.clearTimer);
    state.clearTimer = 0;
  }
  debugClearBtn.textContent = '清空日志';
  debugClearBtn.removeAttribute('data-armed');
}

async function clearLog() {
  if (!storageAvailable) return;
  if (!state.clearArmed) {
    if (state.debugEntries.length === 0) {
      setDebugStatus('日志本来就是空的', 'info');
      return;
    }
    state.clearArmed = true;
    debugClearBtn.textContent = '再点一次清空';
    debugClearBtn.dataset.armed = 'true';
    setDebugStatus('再点一次确认清空（4 秒后取消）', 'warn');
    state.clearTimer = window.setTimeout(() => {
      resetClearButton();
      if (state.debugEntries.length > 0) setDebugStatus('已取消清空', 'info');
    }, 4000);
    return;
  }

  resetClearButton();
  try {
    await chrome.runtime.sendMessage({ type: 'debug.clear' });
    state.debugEntries = [];
    renderDebugList();
    setDebugStatus('日志已清空', 'ok');
  } catch (err) {
    setDebugStatus(`清空失败：${errText(err)}`, 'error');
  }
}

async function addDebugNote() {
  if (!storageAvailable) return;
  const note = debugNoteEl.value.trim();
  if (!note) {
    debugNoteEl.focus();
    setDebugStatus('先写一句备注', 'warn');
    return;
  }

  debugNoteAddBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'debug.log',
      level: 'info',
      event: 'user.note',
      source: 'options',
      note,
    });
    debugNoteEl.value = '';
    setDebugStatus(
      res?.skipped ? '调试日志已关闭，备注没有写入' : '已记录备注',
      res?.skipped ? 'warn' : 'ok',
    );
    await refreshDebugLog();
  } catch (err) {
    setDebugStatus(`记录失败：${errText(err)}`, 'error');
  } finally {
    debugNoteAddBtn.disabled = false;
  }
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

function updatePresetHint() {
  const preset = getPreset(addPresetEl.value);
  const isCustom = preset.id === 'custom';
  presetHintEl.classList.toggle('is-warn', !preset.verified && !isCustom);
  presetHintEl.textContent =
    preset.hint || (preset.verified ? '已验证可用。' : '接口未实测，字段以官方文档为准。');
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
  } else if (field === 'sourceLang') {
    provider.sourceLang = value;
  } else if (field === 'protocol') {
    provider.protocol = /** @type {ProviderConfig['protocol']} */ (value);
  }

  return provider;
}

providersEl.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target instanceof HTMLButtonElement) return;
  applyField(target);
  clearFieldError(target);
  markDirty();
});

providersEl.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const provider = applyField(target);
  if (!provider) return;
  const field = target.dataset.field;
  const index = Number(target.dataset.index);
  const value = /** @type {any} */ (target).value;

  // API Key 填到一定长度就自动拉一次模型列表，省掉一次手动点击；MT 没有模型列表
  if (field === 'apiKey' && !isMtProvider(provider) && String(value ?? '').trim().length > 8) {
    void refreshModels(index);
  }

  // 切到 MT（DeepL / 微软 / Google / Riva）要隐藏模型字段，切回来要恢复；审校下拉也跟着变
  if (field === 'protocol' || field === 'sourceLang') {
    if (isMtProvider(provider) && getDraft().reviewProviderId === provider.id) {
      getDraft().reviewProviderId = null;
    }
    renderProviders();
    renderReviewProviders();
  }

  if (field === 'active') {
    for (const card of providersEl.querySelectorAll('.provider')) {
      if (!(card instanceof HTMLElement)) continue;
      card.dataset.active = card.dataset.index === String(index) ? 'true' : 'false';
    }
  }

  markDirty();
});

providersEl.addEventListener('click', async (event) => {
  if (!storageAvailable) return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest('button[data-action]');
  if (!(button instanceof HTMLButtonElement)) return;

  const index = Number(button.dataset.index);
  const draft = getDraft();
  const provider = draft.providers[index];
  if (!provider) return;

  if (button.dataset.action === 'toggle-key') {
    const input = button.closest('.input-row')?.querySelector('input');
    if (!(input instanceof HTMLInputElement)) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? '隐藏' : '显示';
    button.setAttribute('aria-pressed', reveal ? 'true' : 'false');
    return;
  }

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
    markDirty('已删除，记得保存');
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

  if (button.dataset.action === 'fill-google-key') {
    const result = /** @type {HTMLElement | null} */ (
      button.parentElement?.querySelector('.result') ?? null
    );
    const card = /** @type {HTMLElement | null} */ (button.closest('.provider'));
    const input = /** @type {HTMLInputElement | null} */ (
      card?.querySelector('input[data-field="apiKey"]') ?? null
    );
    if (!result || !input) return;

    result.classList.remove('is-error');
    result.textContent = '正在获取公共测试 key…';
    button.disabled = true;
    try {
      const key = await fetchPublicGoogleKey();
      input.value = key;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      result.textContent = '已填入公共测试 key（来自 KISS 公开源码，可能随时失效）';
      markDirty('已填入公共测试 key，记得保存');
    } catch {
      result.textContent = '获取公共测试 key 失败，请自行填写 Google API Key';
      result.classList.add('is-error');
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (button.dataset.action === 'prepare-builtin') {
    const result = /** @type {HTMLElement | null} */ (
      button.parentElement?.querySelector('.result') ?? null
    );
    if (!result) return;
    result.classList.remove('is-error');
    const TranslatorApi = /** @type {any} */ (globalThis).Translator;
    if (typeof TranslatorApi !== 'function') {
      result.textContent = '当前浏览器没有内置翻译 API（需要桌面版 Chrome/Chromium）';
      result.classList.add('is-error');
      return;
    }

    const sourceLanguage = builtinLang(provider.sourceLang || 'en');
    const targetLanguage = builtinLang(currentTarget().code);
    result.textContent = '正在检查语言包…';
    button.disabled = true;
    try {
      const availability = await TranslatorApi.availability({ sourceLanguage, targetLanguage });
      if (availability === 'unavailable') {
        throw new Error(`Chrome 内置翻译不支持 ${sourceLanguage} → ${targetLanguage}`);
      }
      if (availability === 'available') {
        result.textContent = '语言包已就绪，可以翻译';
        return;
      }
      const translator = await TranslatorApi.create({
        sourceLanguage,
        targetLanguage,
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            result.textContent = `下载语言包 ${Math.round((event.loaded ?? 0) * 100)}%…`;
          });
        },
      });
      translator.destroy?.();
      result.textContent = '语言包已就绪，可以翻译';
    } catch (err) {
      result.textContent = errText(err);
      result.classList.add('is-error');
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (button.dataset.action === 'test') {
    const result = /** @type {HTMLElement | null} */ (
      button.parentElement?.querySelector('.result') ?? null
    );
    if (!result) return;

    resetValidation();
    const missing = missingRequired(provider);
    if (missing.length > 0) {
      showValidation(index, missing);
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
      result.textContent = errText(err);
      result.classList.add('is-error');
    } finally {
      button.disabled = false;
    }
  }
});

addBtn.addEventListener('click', () => {
  if (!storageAvailable) return;
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
  if (preset.id === 'nvidia-riva' || preset.id === 'chrome-builtin') provider.sourceLang = 'en';

  draft.providers.push(provider);
  if (!draft.activeProviderId) draft.activeProviderId = provider.id;
  renderProviders();
  renderReviewProviders();
  updateRivaPreviews();
  markDirty('已添加，填好字段后保存');

  const nameInput = /** @type {HTMLInputElement | null} */ (
    providersEl.querySelector(`.provider[data-index="${draft.providers.length - 1}"] .provider-name`)
  );
  nameInput?.focus();
  nameInput?.select();
});

addPresetEl.addEventListener('change', updatePresetHint);

for (const input of enforcementInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    getDraft().enforcement = getEnforcement();
    updateEnforcementHelp();
    markDirty();
  });
}

useBuiltinEl.addEventListener('change', () => {
  getDraft().glossary.useBuiltin = useBuiltinEl.checked;
  markDirty();
});

termsEl.addEventListener('input', () => {
  getDraft().glossary.terms = termsEl.value.split('\n');
  markDirty();
});

reviewProviderEl.addEventListener('change', () => {
  getDraft().reviewProviderId = reviewProviderEl.value || null;
  markDirty();
});

targetLangEl.addEventListener('change', () => {
  const language = findLanguage(targetLangEl.value);
  if (language) {
    const draft = getDraft();
    draft.targetLang = language.name;
    draft.targetLangCode = language.code;
  }
  updateTargetHint();
  updateRivaPreviews();
  markDirty('目标语言已改，记得保存');
});

debugEnabledEl.addEventListener('change', () => {
  if (!storageAvailable) return;
  void persistDebugFlag('debugLogEnabled', debugEnabledEl.checked);
});

debugSamplesEl.addEventListener('change', () => {
  if (!storageAvailable) return;
  void persistDebugFlag('debugLogSamples', debugSamplesEl.checked);
});

debugNoteAddBtn.addEventListener('click', () => {
  void addDebugNote();
});

debugNoteEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  void addDebugNote();
});

debugCopyBtn.addEventListener('click', () => {
  void copyLog();
});

debugExportBtn.addEventListener('click', () => {
  void exportLog();
});

debugClearBtn.addEventListener('click', () => {
  void clearLog();
});

debugRefreshBtn.addEventListener('click', () => {
  void refreshDebugLog();
  setDebugStatus('已刷新', 'info');
});

/* -------------------------------- 保存 -------------------------------- */

async function saveDraft() {
  if (!storageAvailable || state.saving || !state.draft) return;
  const draft = state.draft;

  resetValidation();
  const invalid = draft.providers
    .map((provider, index) => ({ provider, index, missing: missingRequired(provider) }))
    .filter((entry) => entry.missing.length > 0);

  if (invalid.length > 0) {
    for (const entry of invalid) showValidation(entry.index, entry.missing);
    const firstInvalid = /** @type {HTMLElement | null} */ (
      providersEl.querySelector('.is-invalid')
    );
    firstInvalid?.focus();
    const detail = invalid
      .map(({ provider, missing }) => {
        const name = provider.label || getPreset(provider.presetId).label;
        return `${name}（缺 ${missing.join('、')}）`;
      })
      .join('；');
    setSaveStatus('error', `还有没填完的服务：${detail}`);
    return;
  }

  // Riva 的源语言即使没动过也落一个默认值，方便以后迁移
  for (const provider of draft.providers) {
    if (
      (provider.presetId === 'nvidia-riva' || provider.presetId === 'chrome-builtin') &&
      !provider.sourceLang
    ) {
      provider.sourceLang = 'en';
    }
  }

  const target = currentTarget();
  state.saving = true;
  saveBtn.disabled = true;
  saveBtn.textContent = '保存中…';
  saveBtn.setAttribute('aria-busy', 'true');
  setSaveStatus('saving', '保存中…');

  try {
    const stored = state.stored || draft;
    state.draft = await saveSettings({
      // 只提交设置页负责的字段：displayMode 归 popup，sessionId 归 getSessionId()
      providers: mergeProviderCaches(draft.providers, stored.providers),
      activeProviderId: draft.activeProviderId,
      targetLang: target.name,
      targetLangCode: target.code,
      enforcement: getEnforcement(),
      glossary: {
        useBuiltin: useBuiltinEl.checked,
        terms: normalizeTerms(termsEl.value.split('\n')),
      },
      reviewProviderId: draft.reviewProviderId,
      debugLogEnabled: draft.debugLogEnabled,
      debugLogSamples: draft.debugLogSamples,
    });
    state.stored = structuredClone(state.draft);
    state.dirty = false;
    renderAll();
    setSaveStatus('saved', '已保存');
  } catch (err) {
    setSaveStatus('error', `保存失败：${errText(err)}`);
  } finally {
    state.saving = false;
    saveBtn.disabled = false;
    saveBtn.textContent = '保存设置';
    saveBtn.removeAttribute('aria-busy');
  }
}

saveBtn.addEventListener('click', () => {
  void saveDraft();
});

document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
  event.preventDefault();
  if (!state.saving) void saveDraft();
});

window.addEventListener('beforeunload', (event) => {
  if (!state.dirty || state.saving) return;
  event.preventDefault();
  event.returnValue = '';
});

/* -------------------------------- 启动 -------------------------------- */

async function showGlossaryMeta() {
  if (!storageAvailable) return;
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

function openDebugFromHash() {
  if (location.hash !== '#debug') return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.requestAnimationFrame(() => {
    debugCard.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    debugCard.classList.add('is-target');
    debugCard.focus({ preventScroll: true });
    window.setTimeout(() => debugCard.classList.remove('is-target'), 1800);
  });
}

presetOptions();
updatePresetHint();
initTips(document);

if (!storageAvailable) {
  showEnvironmentWarning();
  openDebugFromHash();
} else {
  // 无 JS 的 file:// 预览也能看到静态提示；扩展环境里把它收起来
  envWarningEl.hidden = true;
  getSettings()
    .then((settings) => {
      state.draft = structuredClone(settings);
      state.stored = structuredClone(settings);
      renderAll();
      setSaveStatus('idle', settings.providers.length ? '设置已加载' : '先添加一个翻译服务');
      void showGlossaryMeta();
      void refreshDebugLog();
      openDebugFromHash();
    })
    .catch((err) => {
      setSaveStatus('error', `读取设置失败：${errText(err)}`);
    });
}

window.addEventListener('hashchange', openDebugFromHash);
