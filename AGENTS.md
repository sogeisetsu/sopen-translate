# AGENTS.md

MV3 浏览器扩展，整页翻译。源码目录 `extension/` 本身就是可加载产物：无打包步骤、无运行时依赖、无 CI。测试是三个 Node 冒烟脚本（`check` / `smoke` / `smoke:dom`），另有一个离线的词库生成脚本（`build:glossary`）。

## 已拍板的决定（别推翻）

- 只做整页翻译。划词翻译被用户明确否掉，别加回来。
- 只支持 Chrome / Edge（MV3），不做 Firefox 兼容。
- 不用 TypeScript 写源码，也不用打包工具。类型靠 JSDoc + `checkJs` 静态检查（`npm run check`），浏览器加载的仍是 `extension/` 里的原始 `.js`。`package.json` 里只有 `typescript`、`@types/chrome` 两个 devDependency；`glossary-data.json` 是数据产物，不是打包产物。
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
- **`content.css` 唯一的作用域例外是 `.sopen-translated-block`**：双语模式的译文必须挂在宿主块元素里，不能塞进 `#sopen-translate-ui`；不要顺手把 toast 样式也放出去。
- 双语模式把译文追加到块内末尾（`span` + `display:block`），**不用兄弟 `div`**：`td/th` 的兄弟 `div` 会破坏表格，`li` 之间插 `div` 不合法。

## 不变量（改之前先读）

- `background.js` 是唯一出网口、唯一读密钥的地方；content script 只发消息。
- `translate()` / `translateBatch()` 必须原序返回与输入等长的数组，数量不符直接抛错——宁可失败，也不能把译文错位写回 DOM。
- 每轮翻译前先 `resetPage()`：否则第二轮会把上一轮译文再翻一遍，且「还原」回不到原文。
- 只有第 0 批失败才立即中止；其余批次计失败后继续，**连续 3 批失败熔断**，保留已翻部分。
- 术语层只校验本批注入 prompt 的 ≤40 条（`termsForPrompt`），不要拿完整词表校验。
- DeepL 完全跳过术语层（不注入、不校验、不回退）。
- 语言只有 `lib/languages.js` 一个来源，popup 与设置页都从它读写。
- `extension/lib/glossary-data.json` 只由 `npm run build:glossary` 生成，不手改；运行时不联网。
- `models.list` 可以用草稿配置发请求，但只把缓存写回「已保存且配置一致」的 provider（`patchProvider`），不要用设置页 draft 覆盖存储。
- 测试不 import `background.js`（service worker 依赖 `chrome.*`）；冒烟只碰 `lib/*.js` 与 `providers.js`。

## 加翻译服务

1. 预设：往 `extension/lib/provider-presets.js` 的 `PROVIDER_PRESETS` 加一条（`id/label/protocol/baseUrl/models/supportsModelList/verified`）；`{baseUrl}/models` 不是通用推导时补 `modelsUrl`。
2. 协议：现有五种（`openai-chat` / `openai-responses` / `anthropic-messages` / `google-gemini` / `deepl`）覆盖绝大多数服务；真要加新协议，往 `extension/lib/protocols.js` 的 `PROTOCOLS` 加实现，并补 `types.d.ts` 的 `ProtocolId`。

设置页按预设自动渲染卡片，不再依赖 `PROVIDER_TYPES` / `type.fields`（那两个只是旧调用方的兼容入口）。

## 验证

- `npm run check` —— `tsc --noEmit`（`checkJs` 模式）。改完必须零错误，这是唯一能自动拦住契约漂移的手段。
- `node --check extension/<file>.js` —— 单独确认某个文件语法（Node 22 自带语法检测，ESM 也能过）。
- `Get-Content extension\manifest.json -Raw | ConvertFrom-Json` —— 验 manifest 结构合法。
- provider 层冒烟测试：`npm run smoke`（`scripts/smoke.mjs`，stub `globalThis.fetch`，不联网）覆盖协议解析、`response_format` 收窄回退、429 退避、模型列表回退、术语三档、旧设置迁移。
- content script 冒烟测试：`npm run smoke:dom`（`scripts/dom-smoke.mjs`，用最小假 DOM 加载真实 `content.js`）覆盖纯译文 / 双语 / 叶子容器 / 长块切分 / 还原 / 双轮 / 模式互切 / 熔断 / 进度。
- 词库：`npm run build:glossary` 生成；`npm run build:glossary -- --check` 校验入库文件与源一致。改 allowlist / snapshot / blocklist 后必须重跑两者。
- 真机只能手工：`chrome://extensions` 加载 `extension/` 目录。**没有真实密钥就没法验证端到端**，别声称跑通了。

## 容易踩的点

- 别给 `#sopen-translate-ui` 加 inline `all: initial`：会重置 `position` / `pointer-events`，反过来覆盖样式表。
- 分批按 provider 策略：LLM 8000 字符 / 400 段、DeepL 3000 字符 / 50 段（DeepL 单请求上限）；并发 LLM 8 路、DeepL 4 路、商汤 1 路；**只有第 0 批失败才中止**（别改回"看 originals 是否为空"，那个判断会被上一轮的残留污染）。
- 输出被截断（分段数不符 / JSON 解析失败）时 `translateBatch` 自动二分重试；HTTP 401/429 不拆，避免放大请求。
- 主趟结束后对失败批串行/低并发（2 路）补跑一次；限流端点的 429 往往是瞬时的。
- 翻译 POST 的超时是 120 秒（`postJson` 默认），大块输出不能沿用 30 秒。
- 每轮翻译开始前必须先还原上一轮的改动（`resetPage()`）：否则第二轮会把译文再翻一遍，且「还原」回不到原文。
- `response_format` 回退只在 400/404/422 触发；401/403/429 直接上抛，否则一次 429 会变成 4+4 次请求。
- OpenCode Go 必须发 `x-opencode-session`（`getSessionId()` 生成的 UUID），漏发就是全网 400。`User-Agent` 只作 best-effort，别把成功建立在它上面。
- 双语模式跳过含 `PRE/CODE/...` 后代的块（含内联 `<code>` 的段落也跳过），这是有意的覆盖率损失，换"不把代码翻坏"。
- 长块按句切到 ≤1200 字符再分别送翻；拼回时 CJK 句末不加空格，拉丁句末加空格。跨句上下文会丢一点，是已知限制。
- `host_permissions: <all_urls>` 和 content script 的 `<all_urls>` 是必要的——接口地址由用户自己填，别收窄成固定域名。
- 只在顶层 frame 生效（`all_frames: false`），是有意为之。
- 类型声明集中在仓库根的 `types.d.ts`，JSDoc 里用 `import('../../types')` 引用；它不会被扩展加载，别挪进 `extension/`。
- `tsconfig.json` 里 `noImplicitAny: false` 是故意的：未注解的参数太多，开了只会刷屏。真正起作用的是 `strictNullChecks` 和 provider 契约检查，别顺手打开。
- 术语层出问题时先关掉设置页的「使用内置词库」复现，再判断是渲染、prompt 还是校验的问题。
- `scripts/build-glossary-snapshot.mjs` 是维护者手动跑的联网脚本，不参与 `build:glossary`；日常构建必须保持离线。

行为变化时同步更新 `README.md`，它同时是对外说明。
