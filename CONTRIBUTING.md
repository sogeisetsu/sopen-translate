# 贡献指南

面向要改代码的人。使用说明、功能清单和隐私说明见 [README.md](README.md)。

## 环境与命令

```bash
npm install                        # 只为类型检查装 typescript + @types/chrome
npm run check                      # tsc --noEmit，改完必须零错误
npm run smoke                      # provider / 协议 / 术语 / 审校 / NVIDIA / 调试日志（stub fetch）
npm run smoke:dom                  # content 状态机：渲染、还原、视口、并发、异步审校、撤销
npm run build:glossary             # 离线生成 extension/lib/glossary-data.json
npm run build:glossary -- --check  # 校验入库词库与源文件一致
```

扩展没有打包步骤：`extension/` 就是 `chrome://extensions` 里加载的产物。源码是 JS + JSDoc，靠 `checkJs` 静态检查；不引入打包器、框架或运行时依赖。

## 目录

```text
extension/
  manifest.json
  background.js            # service worker：消息路由 + 唯一出网口 + 审校预算 + 调试日志写盘
  content.js               # 渲染、视口续翻、segment id、审校队列 / 补丁 / 撤销
  content.css              # 浮层样式；.sopen-translated-block 是唯一作用域例外
  offscreen.html/js        # 唯一能调用 Chrome 端侧 Translator API 的文档
  popup.html/js/css        # 工具栏弹窗
  options.html/js/css      # 设置页
  theme.css                # options / popup 共用的颜色、间距、圆角、明暗主题
  lib/
    settings.js            # 存储、schema 迁移、sessionId
    languages.js           # 语言唯一来源 + DeepL/微软/Google/Riva/内置翻译语言码
    provider-presets.js    # 20 个内置预设 + custom
    protocols.js           # 11 种协议
    providers.js           # translateBatch + reviewTranslations
    review.js              # 候选规则、严重度、二次校验、上下文（纯函数）
    debug-log.js           # 日志脱敏、截断、环形缓冲、导出（纯函数）
    offscreen.js           # background → offscreen 的内置翻译桥
    http.js                # 超时、429 退避、ProviderError
    segments.js / prompt.js / models.js / glossary.js
    ui-tip.js              # ⓘ 信息提示组件（悬停 / 键盘 / 触摸）
    glossary-data.json     # 内置词库（构建产物，不手改）
scripts/
  smoke.mjs / dom-smoke.mjs
  build-glossary.mjs / build-glossary-snapshot.mjs
```

## 分层与作用域

- `extension/background.js`（module）是**唯一出网口**，也是唯一读密钥的地方；content 只发消息。
- `extension/content.js` 是 classic script，**不能出现 `import`**；共享代码走消息，不要为 import 引入打包步骤。
- popup / options / offscreen 是普通页面，可以直接 `import lib/*.js`。
- 浮层只挂 `#sopen-translate-ui`，`pointer-events: none` 不要改。
- 只在顶层 frame 生效、`host_permissions: <all_urls>` 都是必要的，别收窄。
- Chrome 端侧 Translator API 不在 service worker / Web Worker 里，必须经 `offscreen.html` 调用。

## 关键不变量

- `translate()` / `translateBatch()` 必须原序返回等长数组，数量不符直接抛错。
- 每轮翻译前先 `resetPage()`；`resetPage()` 必须断开观察器、清空 pending/seen/审校队列并递增 generation。
- 审校只按 segment id 打补丁；节点断开、generation 不一致时跳过。
- 审校是**异步**的：`translate` 只返回主译文 + 候选；LLM 主翻译返回 `reviewSkipped = "llm-primary"`，不再跑第二层。审校预算按页面累计（200 段 / 8,000 字符）。
- 续翻的 `seenNodes` / `seenBlocks` **只在请求成功后标记**；失败项要放回 pending。`resetPage()` 必须断开全部观察器、清空 pending/seen/progress。
- 自己插入的 `.sopen-translated-block` 与浮层不算“页面变了”，MutationObserver 里要过滤。
- 只有第 0 批失败立即中止；连续 3 批失败熔断，保留已翻部分。
- 术语只校验本批注入 prompt 的 ≤40 条；DeepL、微软、Google 1 / Google 2、NVIDIA Riva、Chrome 内置翻译完全跳过术语层。
- 语言只有 `lib/languages.js` 一个来源；Riva 用 `rivaPair()`，内置翻译用 `builtinLang()`。
- 调试日志默认关闭；关闭时零写入。新增事件必须脱敏（key/Bearer/URL `key=`/session），页面正文只在 `debugLogSamples` 开启时记录。
- 行为变化同步更新 `README.md`、本文件与 `AGENTS.md`。

## 分批、并发、思考

- 按 provider 策略：LLM 8000 字符 / 400 段 / 8 路；DeepL 3000 / 50 / 4；商汤 6000 / 300 / 1；微软 MT 5000 / 100 / 4；Google 1 1500 / 10 / 1；Google 2 3000 / 50 / 2；Riva 3000 / 10 / 2；Chrome 内置 2000 / 20 / 1。
- 视口首屏 / 续翻再收紧到 2000 字符 / 60 段（并发不变），让第一批译文尽快出现；整页模式用完整策略。
- 失败批在主线程结束后用 2 路补跑一次，仍失败才计入 `failed`；并发下熔断可能多带最多 `并发数-1` 批。
- 输出被截断（分段数不符 / JSON 解析失败）时自动二分重试；HTTP 401/429 不拆。
- `postJson` 默认超时 120 秒（大批次实测 28s+）。
- 翻译默认关闭思考；被 400 拒绝时先只去掉思考字段，仍失败才去掉 `response_format`。

## 加翻译服务

1. 预设：`extension/lib/provider-presets.js` 的 `PROVIDER_PRESETS` 加一条（`id/label/protocol/baseUrl/models/supportsModelList/verified/hint`）；`{baseUrl}/models` 不是通用推导时补 `modelsUrl`。
2. 协议：现有 11 种（`openai-chat` / `openai-responses` / `anthropic-messages` / `google-gemini` / `microsoft-edge` / `microsoft-azure` / `google-free` / `google-pa` / `deepl` / `nvidia-riva` / `chrome-builtin`）。新协议加进 `PROTOCOLS`，并补 `types.d.ts` 的 `ProtocolId`；MT 协议设 `supportsGlossary: false`。
3. 额外字段（微软 `region`、Riva / 内置翻译 `sourceLang`）要同时改 `ProviderConfig`、`normalizeSettings` 和设置页卡片。
4. 端侧能力（如 Translator API）放在 `offscreen.js`，不要塞进 service worker。

## 真机测试

- Chrome 品牌版可能忽略 `--load-extension`；用 Edge / Chromium 加 `--load-extension` / `--disable-extensions-except`，路径含空格时要整体加引号。
- 从扩展页用 `chrome.tabs.sendMessage` 驱动；content 里发 `chrome.runtime.sendMessage` 到不了 content 自己的监听器。
- 没有真实 key 时只跑 stub，不要声称端到端通过。Azure / Google 1 / Google 2 / Index-Translate / Chrome 内置翻译目前仍需要真机验证。
- 每个失败项记录：页面 URL、provider/model、模式/范围、步骤、预期/实际、console/Network 截图。
- 截图与导出日志不得出现真实 key、token、邮箱。

## 隐私与密钥

- 仓库任何文件都不准出现真实 key / token / 密码 / 邮箱。仓库是公开的。
- 密钥只允许在运行时 `chrome.storage.local`，或 OpenChamber 环境变量（仓库外的 `.config/openchamber/environment.json`）。
- 冒烟测试一律 stub `fetch`，不联网、不需要 key。
- 调试日志导出前统一脱敏；关闭「记录翻译样本」时不写页面正文。

## 分支与提交

- 不要直接在 `main` 开发：`git switch main && git pull && git switch -c feat/<topic>`。
- 一个分支只做一件事；小步提交，提交信息写清动机。
- 合并前必须 `check` / `smoke` / `smoke:dom` / `glossary --check` 全绿。
- 不要 force-push `main`；推送前确认。

