# AGENTS.md

MV3 浏览器扩展，整页翻译。源码目录 `extension/` 本身就是可加载产物：无构建、无依赖、无测试框架、无 CI。

## 已拍板的决定（别推翻）

- 只做整页翻译。划词翻译被用户明确否掉，别加回来。
- 只支持 Chrome / Edge（MV3），不做 Firefox 兼容。
- 不用 TypeScript、不用打包工具、不装 npm 依赖。没有任何 `package.json`。
- 无后端：请求由 service worker 直接发往用户在设置页填的接口地址。

## 分层与硬约束

- `extension/background.js`（`type: module`）是**唯一出网口**，也是唯一读 `chrome.storage.local` 里密钥的地方。content script 拿不到 key、不 `fetch`，只发消息。
- `extension/content.js` 是 classic script，**不能写 `import`**。要共享代码就走 `chrome.runtime.sendMessage`，不要为了 import 引入打包步骤。
- popup / options 是普通页面，可以直接 `import` `lib/*.js`。
- 注入宿主页面的 UI 一律挂在 `#sopen-translate-ui` 下，只用 `content.css` 里的类名。该 overlay 是 `pointer-events: none`，别改成 `auto`，会挡住页面点击。

## 加翻译服务

往 `extension/lib/providers.js` 的 `PROVIDER_TYPES` 加一个 `{ type, label, hint, fields, translate }` 对象即可，设置页会按 `fields` 自动渲染表单。

`translate()` 必须**原序返回与输入等长的数组**，数量不符直接抛错——宁可失败，也不能把译文错位写回 DOM。

## 验证（没有自动化测试）

- `node --check extension/<file>.js` —— Node 22 自带语法检测，ESM 文件也能过，改完每个文件都跑一遍。
- `Get-Content extension\manifest.json -Raw | ConvertFrom-Json` —— 验 manifest 结构合法。
- provider 层可脱离浏览器测：stub `globalThis.fetch` 后 `import` `lib/providers.js` 直接调 `translate()`，覆盖正常返回、代码块包裹的 JSON、接口拒绝 `response_format`、分段数不符。
- 真机只能手工：`chrome://extensions` 加载 `extension/` 目录。**没有真实密钥就没法验证端到端**，别声称跑通了。

## 容易踩的点

- 别给 `#sopen-translate-ui` 加 inline `all: initial`：会重置 `position` / `pointer-events`，反过来覆盖样式表。
- 整页翻译按 1200 字符 / 20 段分批串行发送；第一批全失败立即中止，避免留下半页译文。改动别破坏这个语义。
- `host_permissions: <all_urls>` 和 content script 的 `<all_urls>` 是必要的——接口地址由用户自己填，别收窄成固定域名。
- 只在顶层 frame 生效（`all_frames: false`），是有意为之。

行为变化时同步更新 `README.md`，它同时是对外说明。
