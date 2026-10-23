/**
 * 说明气泡（tooltip）：把 `[data-tip]` 按钮绑到 `role="tooltip"` 的浮层上。
 *
 * 约定：
 * - 按钮是 `<button type="button" class="info-tip" data-tip="说明文字">`；
 * - 本模块补上 `aria-expanded` / `aria-controls` / `aria-label`，并为每个按钮生成唯一 id；
 * - 悬停、聚焦打开；点击 / 触摸切换；Escape 与点击外部关闭；
 * - 鼠标按下时不让按钮抢走表单焦点（输入框里选中文字再点提示不会丢焦点）；
 * - 浮层是 `position: fixed`，按按钮位置计算并夹在视口内，360px 也不溢出。
 *
 * 动态渲染的按钮可以反复调用 `initTips(root)`：已绑定的会跳过，
 * 已从 DOM 移除的按钮会连同浮层一起清理。
 */

/**
 * @typedef {Object} TipBinding
 * @property {HTMLButtonElement} button
 * @property {HTMLElement} tip
 * @property {boolean} pinned 点击固定
 * @property {boolean} hover 鼠标悬停
 * @property {boolean} focus 键盘 / 触摸聚焦
 * @property {boolean} dismissed 被 Escape 或外部点击临时收起
 * @property {boolean} open 当前是否可见
 */

/** @type {Set<TipBinding>} */
const bindings = new Set();
let seq = 0;
let listenersBound = false;
let rafId = 0;

/**
 * 生成不重复的浮层 id。
 * @returns {string}
 */
function nextTipId() {
  let id = '';
  do {
    seq += 1;
    id = `ui-tip-${seq}`;
  } while (document.getElementById(id));
  return id;
}

/** 清理已经离开 DOM 的按钮对应的浮层。 */
function prune() {
  for (const binding of bindings) {
    if (binding.button.isConnected) continue;
    binding.tip.remove();
    bindings.delete(binding);
  }
}

/**
 * 把浮层放在按钮上方；上方放不下就翻到下方，再夹进视口。
 * @param {TipBinding} binding
 */
function position(binding) {
  const rect = binding.button.getBoundingClientRect();
  const tipRect = binding.tip.getBoundingClientRect();
  const width = tipRect.width;
  const height = tipRect.height;
  if (!width || !height) return;

  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const pad = 10;
  const gap = 8;

  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(pad, Math.min(left, vw - width - pad));

  let top = rect.top - height - gap;
  let side = 'top';
  if (top < pad) {
    top = rect.bottom + gap;
    side = 'bottom';
  }
  if (top + height > vh - pad) {
    top = Math.max(pad, vh - height - pad);
  }

  binding.tip.dataset.side = side;
  binding.tip.style.left = `${Math.round(left)}px`;
  binding.tip.style.top = `${Math.round(top)}px`;
}

/**
 * 把内部状态同步到 DOM。
 * @param {TipBinding} binding
 */
function sync(binding) {
  const open = !binding.dismissed && (binding.pinned || binding.hover || binding.focus);
  binding.button.setAttribute('aria-expanded', open ? 'true' : 'false');

  if (open) {
    binding.tip.hidden = false;
    binding.open = true;
    position(binding);
    return;
  }

  if (!binding.tip.hidden) binding.tip.hidden = true;
  binding.open = false;
}

/**
 * @param {boolean} [dismiss]
 */
function closeAll(dismiss = false) {
  for (const binding of bindings) {
    binding.pinned = false;
    binding.hover = false;
    if (dismiss) binding.dismissed = true;
    sync(binding);
  }
}

/** 同一时间只保留一个打开的气泡。 */
function releaseOthers(binding) {
  for (const other of bindings) {
    if (other === binding || !other.open) continue;
    other.pinned = false;
    other.hover = false;
    other.dismissed = true;
    sync(other);
  }
}

function hasOpen() {
  for (const binding of bindings) {
    if (binding.open) return true;
  }
  return false;
}

/** 页面滚动 / 尺寸变化时重新贴住按钮；按钮离开视口就收起。 */
function repositionOpen() {
  if (!hasOpen()) return;
  if (rafId) return;
  rafId = window.requestAnimationFrame(() => {
    rafId = 0;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    for (const binding of bindings) {
      if (!binding.open) continue;
      const rect = binding.button.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > vh || !binding.button.isConnected) {
        binding.pinned = false;
        binding.hover = false;
        binding.dismissed = true;
        sync(binding);
        continue;
      }
      position(binding);
    }
  });
}

function bindGlobals() {
  if (listenersBound) return;
  listenersBound = true;

  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.info-tip')) return;
      closeAll(true);
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !hasOpen()) return;
    closeAll(true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) closeAll(true);
  });

  window.addEventListener('scroll', repositionOpen, { capture: true, passive: true });
  window.addEventListener('resize', repositionOpen, { passive: true });
}

/**
 * 绑定根节点下所有尚未初始化的 `[data-tip]` 按钮。
 * @param {ParentNode} [root]
 * @returns {{ closeAll: () => void }}
 */
export function initTips(root = document) {
  prune();
  bindGlobals();

  const buttons = root.querySelectorAll('[data-tip]');
  for (const element of buttons) {
    if (!(element instanceof HTMLButtonElement)) continue;
    if (element.dataset.tipReady === '1') continue;

    const text = String(element.dataset.tip ?? '').trim();
    if (!text) continue;

    const tip = document.createElement('span');
    tip.className = 'tip';
    tip.id = nextTipId();
    tip.setAttribute('role', 'tooltip');
    tip.textContent = text;
    tip.hidden = true;
    document.body.append(tip);

    element.type = 'button';
    element.setAttribute('aria-expanded', 'false');
    element.setAttribute('aria-controls', tip.id);
    if (!element.hasAttribute('aria-label')) element.setAttribute('aria-label', '查看说明');
    element.dataset.tipReady = '1';

    /** @type {TipBinding} */
    const binding = {
      button: element,
      tip,
      pinned: false,
      hover: false,
      focus: false,
      dismissed: false,
      open: false,
    };
    bindings.add(binding);

    element.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      releaseOthers(binding);
      binding.hover = true;
      binding.dismissed = false;
      sync(binding);
    });

    element.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      binding.hover = false;
      sync(binding);
    });

    element.addEventListener('pointerdown', (event) => {
      // 鼠标点击不抢焦点：正在编辑的输入框保持焦点与光标位置
      if (event.pointerType === 'mouse') event.preventDefault();
    });

    element.addEventListener('focus', () => {
      releaseOthers(binding);
      binding.focus = true;
      binding.dismissed = false;
      sync(binding);
    });

    element.addEventListener('blur', () => {
      binding.focus = false;
      binding.dismissed = false;
      sync(binding);
    });

    element.addEventListener('click', (event) => {
      if (binding.pinned) {
        binding.pinned = false;
        binding.dismissed = true;
        // 触摸点击时按钮会拿到焦点；主动失焦，第二次点按才能真正关掉
        if (event.detail > 0 && document.activeElement === element) element.blur();
        sync(binding);
        return;
      }
      releaseOthers(binding);
      binding.pinned = true;
      binding.dismissed = false;
      sync(binding);
    });
  }

  return { closeAll };
}
