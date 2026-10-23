# AGENTS.md

MV3 整页翻译扩展。`extension/` 就是可加载产物：无打包、无运行时依赖、无 CI。验证靠三套命令（`npm run check` / `npm run smoke` / `npm run smoke:dom`）和一个离线词库构建。

## 已拍板的决定（别推翻）

- 只做整页翻译；划词 / 右键翻译明确不做。
- 只支持 Chrome / Edge（MV3），不做 Firefox。
- 源码是 JS + JSDoc，靠 `checkJs` 静态检查；不写 TS 源码、不引入打包器。devDependencies 只有 `typescript`、`@types/chrome`。
- 无后端：service worker 直接请求用户在设置页填的接口地址。
- `extension/lib/glossary-data.json` 是数据产物，不是打包产物。

## 分支与合并（硬约束）

- **不要直接在 `main` 上开发。** 每个任务/阶段从最新 `main` 拉分支：
  `git switch main && git pull && git switch -c feat/<topic>`。
- 分支上小步提交；跑完该阶段验收后再合并：
  `git switch main && git merge --no-ff feat/<topic>`，然后 `git push origin main`；推送前按全局规则确认（push 属于高风险操作）。
- 合并前必须 `npm run check` + `npm run smoke` + `npm run smoke:dom` 全绿；冲突在分支上解决。
- 不要 force-push `main`；不要为了省事直接 commit 到 `main`（除非用户明确要求）。
- 命名用 `feat/...`、`fix/...`，一个分支只做一件事。
- **提交身份（硬约束）**：所有提交必须使用用户的全局 Git 身份（`git config --global user.name` / `user.email`），不要用 `-c user.name=... -c user.email=...` 覆盖，也不要自造 `opencode@local` 之类的占位身份。读不到全局身份就停下来问用户，不要猜；不要改用户的 git config。历史里已有的 `opencode <opencode@local>` 提交不主动重写，除非用户明确要求 force-push。

## 隐私与密钥（硬约束）

- 仓库任何文件（源码、注释、测试、文档、计划、commit message）都不准出现真实 key / token / 密码 / 邮箱。仓库是公开的。
- 密钥只允许在运行时 `chrome.storage.local`，或 OpenChamber 环境变量（仓库外的 `.config/openchamber/environment.json`）。
- 冒烟测试一律 stub `fetch`，不联网、不需要 key；不要把真 key 塞进 `scripts/`、`.env` 或 fixture。
- 核实 key 时从环境变量读，不落盘、不打印、不在回复里复述。
- `.gitignore` 已含 `.env*`、`keys.json`、`secrets.json`、`.agents/`、`skills-lock.json`。

## 分层与作用域

- `extension/background.js`（module）是**唯一出网口**，也是唯一读密钥的地方；content 只发消息。
- `extension/offscreen.js` 只调用浏览器端侧 Translator API（`chrome-builtin`），不联网、不读 key；它是唯一能拿到 `Translator` 的上下文。
- `extension/content.js` 是 classic script，**不能出现 `import`**；共享代码走消息，不要为 import 引入打包步骤。
- popup / options 是普通页面，可以直接 `import lib/*.js`。
- 浮层只挂 `#sopen-translate-ui`，`pointer-events: none` 不要改。
- `content.css` 唯一作用域例外是 `.sopen-translated-block`；双语译文追加在块内末尾（`span` + `display:block`），不要用兄弟 `div`。
- 只在顶层 frame 生效、`host_permissions: <all_urls>` 都是必要的，别收窄。

## 不变量（改之前先读）

- `translate()` / `translateBatch()` 必须原序返回等长数组，数量不符直接抛错。
- 每轮翻译前先 `resetPage()`，否则第二轮会翻译文、还原也回不到原文。
- 视口优先（默认）与整页是同一套渲染路径：`content.js` 每次翻译开始时**一次性**读 `displayMode + translateScope`；`whole` 不装观察器，`viewport` 首屏只翻视口 + 500px，之后靠 scroll / resize / MutationObserver / visibilitychange 补翻。
- 续翻的 `seenNodes` / `seenBlocks` **只在请求成功后标记**；失败项要放回 pending，否则会永远漏翻。`resetPage()` 必须断开全部观察器、清空 pending/seen/progress。
- 自己插入的 `.sopen-translated-block` 与浮层不算「页面变了」：MutationObserver 里要过滤，不然每次写入都会触发一次补扫。
- 隐藏标签页暂停补翻；`page.status` 额外返回 `scope` 与 `pending`（是否还有可见未处理候选）。
- 只有第 0 批失败立即中止；连续 3 批失败熔断，保留已翻部分。
- 术语只校验本批注入 prompt 的 ≤40 条（`termsForPrompt`），不要拿完整词表校验。
- DeepL、微软 MT（`microsoft-edge` / `microsoft-azure`）、Google 1（`google-free`）/ Google 2（`google-pa`）、`nvidia-riva` 与 `chrome-builtin` 完全跳过术语层（不注入、不校验、不回退）。
- 语言只有 `lib/languages.js` 一个来源（LLM 用 `name`，DeepL 用 `code`，微软用 `ms`，Google 1 / Google 2 用 `google`，Riva 用 `rivaPair()`，Chrome 内置翻译用 `builtinLang()`）。
- 审校层只处理规则筛出的可疑段：`lib/review.js` 是纯函数（候选、严重度、二次校验），`providers.js` 的 `reviewTranslations()` 接收 `ReviewRunItem[]` 并返回 `{corrections, rejected, review, usedChars}`；它不碰 DOM。审校失败/解析失败/校验不过一律保留主译文，不整段回退；审校服务必须是 LLM（`supportsGlossary !== false`）。
- 审校是**异步**的：`background.translate()` 只返回主译文 + `reviewCandidates`，**不 await 审校**；content 用 400ms 防抖合并候选，主动发 `review.run`。`reviewProviderId` 默认 `null`，关闭时零请求。
- **MT-only 门禁**：主 provider 的 `protocol.supportsGlossary !== false`（LLM）时，translate 直接返回 `reviewSkipped: "llm-primary"` 且不给候选。LLM 主翻译不再跑第二层审校；不要恢复 LLM 双跑，除非另加显式开关。
- 主翻译的术语校验只看本批 `termsForPrompt`（≤40）；审校的 `findSuspicious()` 用完整词表 `compiled.terms`（MT 无 prompt）。
- 审校预算按 content 传来的 `pageToken` 在 background 累计（每页 200 段 / 8,000 字符）；滚动续翻共用 token，还原/重新翻译换新 token。不要改成按单批计算。`selectReviewItems()` 负责按预算裁剪并标记 `truncated`。
- 审校响应只接受 `{ segments: [{ index, corrected }] }`，index 必须属于送审集合；background 把 index 映射回 content 的 `id`，content 只认 id，不依赖批次顺序。
- 修正要在 content 里按 segment id 打补丁：纯译文改 `node.nodeValue`，双语改对应 chunk 后重新 `joinChunks()` 并更新同一个 span；`isConnected === false` 就跳过。
- `resetPage()` 必须递增 `generation` 并清空审校队列/timer/log/targets；晚到的 `review.run` 响应 generation 不一致直接丢弃。`page.restore` 同样走 `resetPage()`。
- 审校 diff 只在内存里（最多 100 条），`page.review` / `page.review.undo` 不持久化；undo 只回滚 applied 条目，不影响还原语义。
- `glossary-data.json` 只由 `npm run build:glossary` 生成，不手改，运行时不联网。
- `models.list` 可以用草稿配置发请求，但只通过 `patchProvider` 把缓存写回「已保存且配置一致」的 provider。
- 设置 schema 是 v2；迁移幂等（`ZH → ZH-HANS`）；`getSessionId()` 单独写入，不要塞进 `getSettings()`。
- 测试不 import `background.js`；冒烟只碰 `lib/*.js` 与 `providers.js`。

## 分批、并发、思考（2026-10 实测）

- 按 provider 策略：LLM 8000 字符 / 400 段 / 8 路；DeepL 3000 / 50 / 4（50 是 DeepL 单请求上限）；商汤 6000 / 300 / 1；微软 MT 5000 / 100 / 4（Azure 单请求上限远高于此，取保守值）；Google 1 1500 / 10 / 1（一次一个 q，必须串行）；Google 2 3000 / 50 / 2（批量 POST）；Riva 3000 / 10 / 2（协议内部一段一请求，实测多行会并成一段）；Chrome 内置翻译 2000 / 20 / 1（端侧顺序处理）。
- 视口首屏 / 续翻在上面的策略之上再收紧到 2000 字符 / 60 段（并发不变）：否则首屏候选会攒成一个 8k 大请求，第一批译文要等整批返回。整页模式仍用完整策略。
- 失败批在主线结束后用 2 路补跑一次，仍失败才计入 `failed`；并发下熔断可能多带最多 `并发数-1` 批。
- 输出被截断（分段数不符 / JSON 解析失败）时自动二分重试；HTTP 401/429 不拆，避免放大请求。
- `postJson` 默认超时 **120 秒**——400 段批次实测 28s+，30 秒会误杀。
- 翻译默认关闭思考：`lib/reasoning.js` 按预设 + 模型返回字段。强制思考、不能发关闭字段：`glm-5.3*`、`kimi-k3`、`MiniMax-M3.1-Flash`；OpenAI `gpt-6.1-sol` / `gpt-6-astra` 不支持 `none`，靠 400 回退。NVIDIA 的 `minimaxai/minimax-m3.1-flash` 实测接受 `reasoning_effort: "none"`。
- 400 时先只去掉思考字段（保留 `response_format`），仍失败才去掉 `response_format`；被拒的配置记入模块级 Set，后续批次不再发。
- OpenCode Go 必须发 `x-opencode-session`（`getSessionId()` 生成），漏发全网 400；`User-Agent` 只作 best-effort。
- 长块按句切到 ≤1200 字符；拼回时 CJK 句末不加空格，拉丁句末加空格。

## 加翻译服务

1. 预设：`extension/lib/provider-presets.js` 的 `PROVIDER_PRESETS` 加一条（`id/label/protocol/baseUrl/models/supportsModelList/verified`）；`{baseUrl}/models` 不是通用推导时补 `modelsUrl`。
2. 协议：现有十一种（`openai-chat` / `openai-responses` / `anthropic-messages` / `google-gemini` / `microsoft-edge` / `microsoft-azure` / `google-free` / `google-pa` / `deepl` / `nvidia-riva` / `chrome-builtin`）。新协议加进 `extension/lib/protocols.js` 的 `PROTOCOLS`，并补 `types.d.ts` 的 `ProtocolId`；MT 协议要设 `supportsGlossary: false`。
3. 需要额外字段（如微软的 `region` / Riva、内置翻译的 `sourceLang`）时，同时改 `ProviderConfig`、`normalizeSettings` 和设置页卡片。
4. 端侧 / DOM-only 能力放 `extension/offscreen.js`（经 offscreen 文档调用），不要塞进 service worker；`chrome-builtin` 就是例子。

设置页按预设渲染，不再依赖 `PROVIDER_TYPES` / `type.fields`（那只是旧调用方的兼容入口）。微软 Edge / Azure 已实现；Index-Translate 只提供本地代理预设。

## 验证

- `npm run check` —— `tsc -p .`（`noEmit` 在 tsconfig 里）。改完必须零错误。
- `npm run smoke` —— 协议解析、`response_format` / 思考字段回退、429、模型列表、术语三档、迁移、思考映射、审校候选/预算/二次校验、NVIDIA 两个协议、Google 1 / Google 2、Chrome 内置翻译语言码、调试日志脱敏/截断/环形缓冲/导出；stub `fetch`，不联网。
- `npm run smoke:dom` —— 假 DOM 加载真实 `content.js`：渲染、还原、双轮、视口/滚动、并发、失败补跑、熔断、进度、异步审校补丁/竞态/撤销、调试事件。
- 两个冒烟脚本都不支持按用例过滤；单测就临时抽一个用例单独跑，不要改脚本参数硬跑。
- `npm run build:glossary`；改 allowlist / snapshot / blocklist 后必须再跑 `npm run build:glossary -- --check`。`build:glossary:snapshot` 是维护者手动联网脚本，不参与构建。
- `node --check extension/<file>.js`；`Get-Content extension\manifest.json -Raw | ConvertFrom-Json` 按需验语法 / manifest。
- 真机没有自动化套件。实测 **Chrome 155 品牌版忽略 `--load-extension`**；用 Edge / Chromium headless 加 `--load-extension` / `--disable-extensions-except`。从扩展页用 `chrome.tabs.sendMessage` 驱动——从 content 里发 `chrome.runtime.sendMessage` 到不了 content 自己的监听器。Cloudflare 页面需要正常 UA + `--disable-blink-features=AutomationControlled`。
- 真机只用计划「测试范围」允许的模型；没有真实 key 不要声称端到端跑通。

## 计划与本地工具

- `.openchamber/plans/1792675488233-sopen-translate-opencode-go.md` 是 A–G 的施工图与验收记录。阶段 A–F 与 G1 均已落地（含 E 的视口优先 / 滚动续翻、F 的微软翻译 + 可选审校、G1 的 Google 免费接口 stub）；G2 只做了 spike（`downloadable`，未接入）。
- H 计划（`1792748247352-sopen-translate-h.md`）已落地：审校异步化 + MT-only、NVIDIA 双预设、UI 改版、README 重写、本地调试日志。计划文件里记录验收结果；别再按“H 未落地”的旧状态判断代码。
- 调试日志：`lib/debug-log.js` 是纯函数（脱敏/截断/环形缓冲/导出）；写盘只走 background 的 `debug.log`，串行队列避免并发覆盖。`debugLogEnabled` 默认 false，关闭时零写入；`debugLogSamples` 默认 false，开启才记录 ≤120 字样本。content 只在每轮翻译开始时读一次 `debugLogSamples`。
- `.agents/` 与 `skills-lock.json` 是本地安装的 agent skill（含 `chrome-extensions`），已 gitignore，不要提交。
- 参考 KISS Translator 时只借鉴思路 / 默认值；它是 **GPL-3.0**，不要复制源码、prompt、资源，也不要作为依赖引入。

## 容易踩的点

- 不要给 `#sopen-translate-ui` 加 inline `all: initial`：会重置 `position` / `pointer-events`。
- `response_format` 回退只在 400/404/422；401/403/429 直接上抛，否则一次 429 会变成 8 次请求。
- Microsoft Edge 是浏览器内部接口：`POST /translate/translatetext?...`，body 是**纯字符串数组**，没有 Authorization；Azure 是 `[{ Text }]` + `Ocp-Apim-Subscription-Key`（区域资源还要 `Ocp-Apim-Subscription-Region`）。两者响应同形，别把 body 混用。
- Google 1（`google-free`）一次只能发一个 `q`，长文本按 ≤1600 字符切开串行请求；本机出口实测可达但返回 429，预设只做 stub、不做默认。
- Google 2（`google-pa`）是 `POST https://translate-pa.googleapis.com/v1/translateHtml`：`Content-Type: application/json+protobuf` + `X-Goog-API-Key`，body 为 `[[texts, from, to], "wt_lib"]`，响应为 `[[translations], [langs]]`。需要用户自己的 key，**不要**把 KISS Translator 等项目的公共 key 内置进仓库。
- 双语会跳过含 `PRE/CODE/KBD/SAMP/...` 后代的块（含内联 `<code>`），这是有意的覆盖率损失。
- 视口判定的 rect 全 0 视为隐藏/未布局；`smoke:dom` 的假 DOM 默认给可见 rect，测视口用例时用 `offscreen(el)` 设置元素 rect。
- `smoke:dom` 的 `window` / `document` 事件与 `MutationObserver` 都是桩：要触发续翻，用 `fireListener(windowListeners, 'scroll')` 或 `fireMutations(...)`。
- 叶子容器回退：`div/section/article/main` 没有块级后代且文本 ≥40 字才算一块。
- `nvidia-riva` 的 system **只能**是语言对（`en-zh-cn`）；塞术语/JSON 指令会被当成正文翻译。它一次只发一段，多行输入会被合并，别为了省请求合并。
- `chrome-builtin` 的 Translator API **不在 service worker / Web Worker**，只能经 `offscreen.html`；`Translator.create()` 在语言包未下载时需要 user activation（设置页「准备语言包」按钮），offscreen 里直接 create 会抛 `NotAllowedError`。下载完成后才是纯端侧、无网络。
- Google 1 在本机出口实测是 HTTP 429（可达但被限流），不要写成“网络不可达”；Google 2 用公共 key 实测 200，但仓库不内置该 key。
- 审校补丁只认 content 生成的 segment id；不要把模型返回的 index 直接写回 DOM（index 是 background 送审切片里的位置，不是页面顺序）。
- `debug.log` 关闭时由 background 静默丢弃；不要在 content 里新增 storage 读取来判断开关。新增日志事件要同时确认脱敏（key/Bearer/URL `key=`/session）与 samples 门禁。
- 术语层出问题先关掉设置页的「使用内置词库」复现，再判断是渲染、prompt 还是校验。
- `tsconfig.json` 的 `noImplicitAny: false` 是故意的；真正生效的是 `strictNullChecks` 与契约检查，别顺手打开。
- 行为变化同步更新 `README.md`，它同时是对外说明。
