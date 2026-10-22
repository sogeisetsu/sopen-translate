# AGENTS.md

MV3 浏览器扩展，整页翻译。源码目录 `extension/` 本身就是可加载产物：无构建、无运行时依赖、无 CI，测试只有一个 provider 冒烟脚本。

## 已拍板的决定（别推翻）

- 只做整页翻译。划词翻译被用户明确否掉，别加回来。
- 只支持 Chrome / Edge（MV3），不做 Firefox 兼容。
- 不用 TypeScript 写源码，也不用打包工具。类型靠 JSDoc + `checkJs` 静态检查（`npm run check`），浏览器加载的仍是 `extension/` 里的原始 `.js`，不存在构建产物。`package.json` 里只有 `typescript`、`@types/chrome` 两个 devDependency。
- 无后端：请求由 service worker 直接发往用户在设置页填的接口地址。

## 绝对禁止：仓库里不许出现任何隐私数据

- **任何 API Key、token、密钥、账号密码、cookie、个人邮箱/手机号，一律不准写进这个仓库的任何文件**：源码、注释、示例、测试、文档、计划、commit message、issue/PR 正文都不行。这个仓库是公开的，推到 GitHub 就等于泄露。
- 密钥只允许存在于两个地方：运行时用户的 `chrome.storage.local`，或开发期 OpenChamber 项目的环境变量（`.config/openchamber/environment.json`，不在仓库内）。代码里只准出现占位符，如 `sk-...`、`<YOUR_API_KEY>`、`d735...:fx`。
- 不要为了"方便测试"把真实 key 塞进 `scripts/`、`.env`、临时 JSON 或 fixture；冒烟测试一律 stub `fetch`，不联网、不需要 key。
- 需要核实某个 key 是否可用时，从环境变量读、在命令行里用，不要落盘、不要打印、不要在回复里复述。
- `.gitignore` 已屏蔽 `.env*`、`keys.json`、`secrets.json`；新增凭据文件时同步加进去。提交前扫一眼 `git diff`，发现 key 立刻删掉并视为已泄露（改 key，而不是只删文件）。

## 分层与硬约束

- `extension/background.js`（`type: module`）是**唯一出网口**，也是唯一读 `chrome.storage.local` 里密钥的地方。content script 拿不到 key、不 `fetch`，只发消息。
- `extension/content.js` 是 classic script，**不能写 `import`**。要共享代码就走 `chrome.runtime.sendMessage`，不要为了 import 引入打包步骤。
- popup / options 是普通页面，可以直接 `import` `lib/*.js`。
- 注入宿主页面的 UI 一律挂在 `#sopen-translate-ui` 下，只用 `content.css` 里的类名。该 overlay 是 `pointer-events: none`，别改成 `auto`，会挡住页面点击。

## 加翻译服务

往 `extension/lib/providers.js` 的 `PROVIDER_TYPES` 加一个 `{ type, label, hint, fields, translate }` 对象即可，设置页会按 `fields` 自动渲染表单。

`translate()` 必须**原序返回与输入等长的数组**，数量不符直接抛错——宁可失败，也不能把译文错位写回 DOM。

## 验证（没有自动化测试）

- `npm run check` —— `tsc --noEmit`（`checkJs` 模式）。改完必须零错误，这是唯一能自动拦住契约漂移的手段。
- `node --check extension/<file>.js` —— 单独确认某个文件语法（Node 22 自带语法检测，ESM 也能过）。
- `Get-Content extension\manifest.json -Raw | ConvertFrom-Json` —— 验 manifest 结构合法。
- provider 层冒烟测试：`npm run smoke`（`scripts/smoke.mjs`，stub `globalThis.fetch`，不联网）覆盖正常返回、代码块包裹、接口拒绝 `response_format` 时回退、分段数不符、无法解析、HTTP 错误、连接失败。改动 provider 后必须重跑。
- content script 状态机冒烟测试：`npm run smoke:dom`（`scripts/dom-smoke.mjs`，用最小假 DOM 加载真实 `content.js`），覆盖"两轮翻译后还原回到原文"、翻译中拒绝还原、pre/过短文本跳过。改状态机后必须重跑。
- 真机只能手工：`chrome://extensions` 加载 `extension/` 目录。**没有真实密钥就没法验证端到端**，别声称跑通了。

## 容易踩的点

- 别给 `#sopen-translate-ui` 加 inline `all: initial`：会重置 `position` / `pointer-events`，反过来覆盖样式表。
- 整页翻译按 1200 字符 / 20 段分批串行发送；**只有第 0 批失败才中止**（别改回"看 originals 是否为空"，那个判断会被上一轮的残留污染）。
- 每轮翻译开始前必须先还原上一轮的改动（`originals` 复位）：否则第二轮会把译文再翻一遍，且「还原」回不到原文。
- `host_permissions: <all_urls>` 和 content script 的 `<all_urls>` 是必要的——接口地址由用户自己填，别收窄成固定域名。
- 只在顶层 frame 生效（`all_frames: false`），是有意为之。
- 类型声明集中在仓库根的 `types.d.ts`，JSDoc 里用 `import('../../types')` 引用；它不会被扩展加载，别挪进 `extension/`。
- `tsconfig.json` 里 `noImplicitAny: false` 是故意的：未注解的参数太多，开了只会刷屏。真正起作用的是 `strictNullChecks` 和 provider 契约检查，别顺手打开。

行为变化时同步更新 `README.md`，它同时是对外说明。
