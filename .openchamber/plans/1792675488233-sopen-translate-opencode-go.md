# sopen-translate 实施方案：双语模式 + 术语保护 + 多 provider

面向下一个执行会话的施工图。按 A → B → C → D 顺序施工，每阶段有独立验收命令，做完一段再动下一段。

核心目标：`DeepSeek V4.1 Flash` 不该被译成“深度思考 4.1 闪电版”。

本轮（2026-10-22）已把计划与仓库现状、线上端点、数据源重新对齐。下文的「决策记录」是本轮拍板项；标 **【实测】** 的是当天验证过的事实，标 **【未实测】** 的不要当成已验证。

---

## 决策记录（2026-10-22，本轮已拍板）

| 主题 | 决策 | 理由 |
| --- | --- | --- |
| 内置词库 | 仓库内人工维护 `scripts/glossary-allowlist.txt` + 一份筛过的快照；`build:glossary` 完全离线；总量硬上限 800 条 | 原始数据会把 `X`、`Circle`、`Square`、`Search`、`Fast`、`bat` 这类普通词当品牌保护，直接全量入库会大面积误伤 |
| 用户词表 | 一行一个词，只做“保持原文”（DNT），不做“术语 → 指定译法” | 先锁住“不被翻译”这一条核心目标；映射会引入格式、冲突、校验三层复杂度 |
| 术语策略 | 全局一档；三选一：`fallback` 回退原文 / `repair` 修复重试后回退 / `warn` 只提示；新装默认 `repair` | 用户明确要求把三种后果写清楚；默认值在“页面完整度”和“核心目标”之间取平衡 |
| DeepL | 完全跳过术语层：不注入、不校验、不回退；设置页标注 | DeepL 没有 prompt 通道，硬校验只会让它频繁回退，看起来像故障 |
| 双语插入 | 译文追加到块内末尾（`span` + `display:block`），不再用兄弟 `div` | `td/th` 的兄弟 `div` 会破坏表格，`li` 之间插 `div` 不合法 |
| 纯 div 页面 | 增加“叶子容器”回退：无块级后代的 `div/section/article/main`，块文本足够长也算块 | 只按 `p/li/h*` 白名单会让 div-soup 站点一段都不出 |
| 超长块 | 按句切分到 ≤1200 字符，分别送翻后拼回一个译文块 | 一块装不进一批时，不能跳过内容，也不能整块超预算 |
| 协议 | 保留 5 个：`openai-chat` / `openai-responses` / `anthropic-messages` / `google-gemini` / `deepl` | 保留扩展位；Anthropic / Gemini / Responses 仅自定义可用 |
| 预设 | 12 个内置（11 个 LLM + DeepL）+ 自定义；未用真 key 跑过的标“接口未实测” | 12 个全上降低配置门槛，但必须诚实标注验证状态 |
| 模型 | 下拉 + 联网刷新；OpenCode Go 用独立 `modelsUrl` | 【实测】`/inference/go/openai/v1/models` 是 404，`/inference/go/v1/models` 是 200；不能用 `{baseUrl}/models` 一把梭 |
| 语言 | popup 与设置页统一 10 项下拉（`lib/languages.js`） | 两处各写一套必然漂移；老用户列表外的值保留为只读“当前：X”项 |
| 进度 | popup 轮询 `page.status`（新增 `progress`） | 不新增消息链路；popup 关掉也不影响翻译继续 |
| 熔断 | 连续 3 批失败停止，保留已翻部分 | 防止限流时把剩下几十批全打一遍；页面上已翻的内容不丢 |
| 默认展示 | 纯译文 | 保持现有行为，老用户升级无意外；双语由用户主动切 |
| `response_format` | 只在 400/404/422 时去掉重试；401/403/429 直接上抛 | 现有“任意 4xx 就去掉再试”叠加 429 退避会让一次 429 最多打 8 次请求 |
| `models.list` | 只对 `openai-chat` 联网；其他协议返回预设建议 | Anthropic / Gemini / Responses 没有内置预设，`/models` 的鉴权和返回结构都未验证 |
| OpenCode Go 请求头 | `x-opencode-session` 是硬需求；`User-Agent` 只作 best-effort，不作为成功条件 | 错误原文只点名 session；浏览器 fetch 对 `User-Agent` 有限制，不能把成功建立在它上面 |

---

## Steps

- [x] **A0 基线**：`npm run check` / `npm run smoke` / `npm run smoke:dom` 先全绿，记下当前 9 + 6 个用例的通过状态
- [x] A1 类型与存储：`types.d.ts` 扩展；`lib/settings.js` 加 `schemaVersion` / `enforcement` / `sessionId` / 迁移 / `patchProvider`
- [x] A2 基础设施：新增 `lib/http.js`、`lib/segments.js`、`lib/prompt.js`、`lib/protocols.js`
- [x] A3 预设与模型：新增 `lib/provider-presets.js`、`lib/models.js`；OpenCode Go 独立 `modelsUrl`
- [x] A4 `lib/providers.js` 重构：协议注册 + `translateBatch()`；保留 `getProviderType()` 兼容入口
- [x] A5 `background.js`：`models.list` 消息；`translate` 走 pipeline；`testProvider` 跳过术语层
- [x] A6 设置页：12 预设 + 自定义、模型下拉 + 刷新、术语三档、语言下拉、关于
- [x] A7 验收 A：`npm run check` + `npm run smoke` 通过（新增用例见 A7）
- [x] B1 存储：`displayMode` 读取与回显
- [x] B2 `content.js`：块内追加双语译文 + 叶子容器回退 + 按句切分 + 统一还原 + 熔断 + 进度
- [x] B3 `content.css`：`.sopen-translated-block`（唯一作用域例外）
- [x] B4 popup：圆形主按钮 + 模式切换 + 语言下拉 + 轮询进度
- [x] B5 验收 B：`npm run smoke:dom` 通过（新增用例见 B5）
- [x] C1 词库：`glossary-allowlist.txt`、`glossary-snapshot.json`、`build-glossary.mjs` → `lib/glossary-data.json`（离线、入库）
- [x] C2 术语匹配：`lib/glossary.js`（纯函数）
- [x] C3 prompt 注入 + 译后校验 + 修复重试（在 pipeline 内）
- [x] C4 设置页：术语表编辑 + 内置词库开关 + 三档说明 + 关于与许可
- [x] C5 `THIRD-PARTY-NOTICES.md`
- [ ] C6 验收 C：三套命令全绿 + 四个真机页面手工验收 + `build:glossary` 幂等（三套命令与 `build:glossary --check` 已通过；四个真机页面未跑，本机无已加载扩展的浏览器会话）
- [x] D1 收尾：`manifest.json` 版本 0.2.0，README / AGENTS.md / package.json 同步

---

## 测试范围（硬约束，别扩大）

只允许用这三个服务、这几个模型做真机/联网测试，**不要碰 OpenCode Go 下的其他模型**（每个都在烧 token）：

| 服务 | 允许的模型 | 备注 |
| --- | --- | --- |
| 商汤 | `sensenova-6.8-flash-lite` | 只这一个 |
| OpenCode Go | `deepseek-v4.1-flash` | ✅ 已实测可用 |
| OpenCode Go | `mimo-v2.6-flash` | ✅ 已实测可用 |
| OpenCode Go | `minimax-m3.1-flash-free` | 名字里的 `-free` 就是免费档，优先用它 |
| OpenCode Go | ~~`longcat-2.5-preview`~~ | ❌ **已排除**：面板可见但 API 打不通（`402 Endpoint is unavailable` / `400 Model is unavailable`），`/models` 里也没有它。不要测、不要找替代模型 |
| DeepL | 无需选模型 | ✅ key 已验证，字符额度 0/1,000,000 |

其它约束：

- 不测试 `deepseek-v4-pro`、`glm-*`、`kimi-*`、`gpt-5.6-luna`、`mimo-v2.5*`、`mimo-v2.6-pro`、`minimax-m2.*`、`minimax-m3` 等模型，哪怕它们出现在下拉里。
- 不接智谱 / 阿里 / Kimi / MiniMax 官方 / OpenRouter / 硅基流动的真 key 去跑真实翻译；这些预设只做单元 stub 测试（`npm run smoke`），不联网。
- 真机验收只跑那四个页面，每页每模式**跑一次**，不反复重跑；调试优先用 3 段文本的本地样例。
- 冒烟测试一律 stub `fetch`，永久不消耗额度。

---

## 0. 前置核查结果

### 0.1 端点与协议

| 检查项 | 实测结果 |
| --- | --- |
| `POST https://api.openai.com/v1/responses` | 401（路由存在） |
| `POST https://api.anthropic.com/v1/messages` | 401，错误原文要求 `x-api-key`（确认不走 Bearer） |
| `POST generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=` | 400「API key not valid」（路由存在，key 走 query） |
| `POST https://api-free.deepl.com/v2/translate` | 403，原文要求 `Authorization: DeepL-Auth-Key <key>`（与现有实现一致） |
| OpenCode Go `GET https://opencode.ai/inference/go/v1/models` | **200，且不需要 key**，返回 36 个模型，含 `deepseek-v4.1-flash`、`glm-5.3`、`glm-5.3-flash`、`gpt-5.6-luna` |
| OpenCode Go `GET https://opencode.ai/inference/go/openai/v1/models` | **404（本轮实测）**；所以 `{baseUrl}/models` 不能作为通用推导 |
| OpenCode Go `POST .../openai/v1/chat/completions` 与 `POST .../v1/chat/completions` | 不带 session 头时都返回 400 `MissingSessionID`（两个路径都存在；带 key 的成功实测沿用 `.../openai/v1`） |
| OpenAI / DeepSeek / 硅基流动 / OpenRouter 的 `/models` | 401 或 200，路由均存在 |
| 商汤 `token.sensenova.cn/v1/models` | 200，结构 `{data:[{id,...}]}`，7 个模型，含 `sensenova-6.8-flash-lite`、`deepseek-v4.1-flash`、`kimi-k3` |
| Kimi / 智谱 / 阿里百炼 / MiniMax 的 `/models` | 全部 401 → 路由存在，⚠️ 响应结构待真 key 验证 |

结论：11 个 LLM 预设都可以“尝试”拉模型列表，但地址不一定等于 `{baseUrl}/models`（OpenCode Go 就是反例），所以 A3 的预设必须带可选 `modelsUrl`。DeepL 不适用模型列表。

### 0.2 词库数据源与误伤风险

| 源 | 实测 | 关键风险 |
| --- | --- | --- |
| `https://unpkg.com/simple-icons@latest/data/simple-icons.json` | 200，456 KB，顶层数组 3466 项；`title` 去重后约 38.9 KB | 1970 个 1–8 字符的纯 ASCII 单词标题，其中 103 个以小写字母开头，含 `bat`、`comma`、`smart`、`sharp`、`remark`、`mailbox`；还有 `X`、`Circle`、`Square`、`Meta`。**不能直接当 DNT 词表** |
| `https://models.dev/api.json` | 200，6.05 MB；232 厂商 / 9143 模型；去重后 3606 个模型名，约 83.8 KB | 49 个 2–10 字符的纯单词名字，含 `Search`、`Fast`、`Large`、`Auto`、`Echo`、`Fusion`、`Extract`、`Summarize`。**快照必须过滤** |
| linguist `languages.yml` | 200，166 KB，顶层语言名 836 个 | `Go`、`Rust`、`Swift`、`C`、`R` 都是普通词或单字母；**不要整表导入**，只允许 allowlist 里的语言名 |
| CNCF glossary `content/zh-cn` | 74 个 `.md`；raw 可取，但本轮抓取出现过一次 `ECONNRESET`，快照脚本需要重试 | 中文标题混排（`Kubernetes`、`开发运维 (DevOps)`、`容器`）；只抽 ASCII 片段，纯中文丢弃 |

结论：内置词库以人工 allowlist 为主，快照只补充“多词 / 含数字 / 明确品牌”的条目，两者合计硬上限 800。

### 0.3 四个验收页

| 页面 | 实测注意点 |
| --- | --- |
| `opencode.ai/go` | 73 KB 服务端渲染，品牌/模型名密集 |
| `github.com/anomalyco/opencode/issues/55772` | 280 KB，**React 渲染**：原始 HTML 里只有 8 个 `<p>`，正文靠 JS 注入。测这页要等渲染完成再点翻译，正好当 SPA 场景的样本 |
| `linux.org/pages/download` | 65 KB 服务端渲染，列表/表格 |
| `en.wikipedia.org/wiki/Linux` | 972 KB，长文 + 内链 + 脚注 + 信息框表格 |

### 0.4 模型 ID 核对（对 models.dev 与 Go 的 `/models` 交叉验证）

- 存在：`deepseek-v4.1-flash`、`deepseek-v4-pro`、`deepseek-flash`、`glm-5.3`、`glm-5.3-flash`、`kimi-k3`、`kimi-k2.6`、`qwen3.8-flash`、`qwen-flash`、`MiniMax-M3.1-Flash`、`MiniMax-M3`、`openai/gpt-5.2`、`sensenova-6.8-flash-lite`、`deepseek-ai/DeepSeek-V4-Flash`、`moonshotai/Kimi-K2.6`、`gpt-6-luna`、`gpt-6.1-sol`、`gpt-5.6-luna`。
- **不存在**（原方案写错，已改）：`sensenova-6.7-flash-lite`、`glm-5.3-Flash`（正确写法是小写 `glm-5.3-flash`）、`gpt-6-astra`/`gpt-6-sol`/`gpt-5.6-terra`（只出现在 Azure/Copilot 的目录里，OpenAI 官方目录用 `gpt-6-luna` 一系）。
- 这些 ID 只作为预设建议；用户点“刷新”后以接口返回为准。

### 0.5 真 key 实测（2026-10-22，项目环境变量里已有 key）

| 检查 | 结果 |
| --- | --- |
| OpenCode Go `GET /v1/models`（带 key） | 200，36 个模型，含 `deepseek-v4.1-flash`、`mimo-v2.6-flash`、`minimax-m3.1-flash-free` |
| OpenCode Go `POST /chat/completions`（只有 Bearer） | **400 `MissingSessionID`**：必须带请求头 `x-opencode-session` |
| 同上，补 `x-opencode-session: <uuid>` + `User-Agent` | 200，`deepseek-v4.1-flash` 与 `mimo-v2.6-flash` 均正常返回 `{"segments":[...]}` |
| OpenCode Go + `response_format: json_object` | `mimo` / `minimax-m3.1-flash-free` 直接可用；**`deepseek-v4.1-flash` 要求 prompt 里出现 "json" 字样**，否则 400 `Prompt must contain the word 'json'`。现有 `SYSTEM_PROMPT` 已有 "JSON"，但回退逻辑必须保留 |
| 商汤 `GET /v1/models` | 200，结构 `{data:[{id,...}]}`，7 个模型 |
| 商汤 `POST /chat/completions`（`sensenova-6.8-flash-lite`） | 200；`content` 前置换行、另带 `reasoning` 字段；**并发打会触发 `429 inference exceeds tpm/rpm limit`** |
| DeepL `GET /v2/usage` | 200，`{"character_count":0,"character_limit":1000000}`，key 可用 |

实测翻译质量（3 段样本，目标简中）：`deepseek-v4.1-flash` 与 `mimo-v2.6-flash` 都把 `DeepSeek V4.1 Flash`、`Kubernetes` 原样保留——初衷方向是对的；`mimo` 倾向保留 `Download`，`deepseek` 译成“下载”，两者都能接受。

结论：

1. OpenCode Go **必须**发 `x-opencode-session: <uuid>`（每安装生成一次、存 `storage.local`、随请求带上），否则全部 400。
2. `response_format` 的失败回退要覆盖 400 语义；但**不能**把 401/403/429 也当成“参数不支持”去重发（见 0.6）。
3. 商汤 RPM 限制很低，**429 必须退避重试**，否则长页面必然半数批次失败。
4. `User-Agent` 不作为成功条件；如果未来确认 Go 必须校验 UA，再单独评估 `declarativeNetRequest`，本轮不引入新权限。

### 0.6 本轮新增核查（2026-10-22）

| 检查 | 结果 |
| --- | --- |
| OpenCode Go 的 models 地址 | `/inference/go/openai/v1/models` → **404**；`/inference/go/v1/models` → **200**。预设必须分开 `baseUrl` 与 `modelsUrl` |
| OpenCode Go 的 chat 路由 | 两个 base 的 `/chat/completions` 都返回 `MissingSessionID`（不是 404），说明路径都在；本轮不改变 `baseUrl = .../openai/v1` |
| simple-icons 通用词 | 3466 个 title 中 1970 个是纯 ASCII 单词，103 个以小写字母开头；`X`/`Circle`/`Square` 等会误伤正文 |
| models.dev 通用词 | 3606 个名字中 49 个是纯单词；`Search`/`Fast`/`Large`/`Auto`/`Echo` 会误伤正文 |
| `response_format` 放大 | 代码审查：现有 `providers.js` 对任意 `HTTP 4\d\d` 都去掉 `response_format` 重发；若 429 退避放在 `postJson`，一次 429 最多变成 4 + 4 次请求。A2 必须把回退收窄到 400/404/422 |
| `User-Agent` | 未在 Chrome 扩展环境单独验证；Fetch 规范对 `User-Agent` 有限制。只把它当可选头，不作为验收条件 |

### 0.7 ⚠️ 仍需写码或后续观测才能确认的

1. 智谱 / 阿里 / MiniMax 的 `/models` 返回体结构（商汤已确认 `{data:[{id}]}`，其余未拿真 key 验）。
2. OpenCode Go 对整页翻译流量的长期风控态度（本次 6 次请求未触发）。
3. Go 各模型的真实计费与 5 小时窗口的实际可用量。
4. 商汤在连续 20 段/批的节奏下会不会稳定 429。
5. Chrome 扩展 service worker 里 `User-Agent` 是否可设置；本轮不依赖。
6. 12 个预设中除 OpenCode Go / 商汤 / DeepL 外的 9 个，只有路由级验证，没有真 key 端到端。

---

## 1. 现状快照

### 1.1 动手前先读这些文件

| 文件 | 现状 |
| --- | --- |
| `extension/manifest.json` | MV3，`permissions: ["storage"]`，`host_permissions: ["<all_urls>"]`，content script 单文件 `content.js` + `content.css`，`all_frames: false`，版本 0.1.0 |
| `extension/background.js` | 唯一出网口；消息 `translate` / `testProvider` / `status`；`translate` 校验等长；`getActiveProvider()` 读当前 provider |
| `extension/lib/settings.js` | `DEFAULT_SETTINGS` = `{targetLang, targetLangCode, activeProviderId, providers}`，全部存 `chrome.storage.local` 的 `settings` 键；`getSettings()` 只做浅合并，没有迁移 |
| `extension/lib/providers.js` | `PROVIDER_TYPES = [openai, deepl]`；`openai` 内含 `SYSTEM_PROMPT`、`parseSegments`、`response_format` 回退；`apiKey` 在字段里**不是必填**（为 Ollama/One-API 留口） |
| `extension/content.js` | classic script；文本节点 TreeWalker + 1200 字符/20 段分批 + `originals` 数组还原；消息 `page.translate` / `page.restore` / `page.status` |
| `extension/content.css` | 只有 `#sopen-translate-ui` 与 `.sopen-toast`；README/AGENTS 都写着“全部样式限定在 `#sopen-translate-ui`” |
| `extension/options.html/js/css` | 设置页按 `type.fields` 自动渲染 provider 卡片；`options.js` 顶部 `import { PROVIDER_TYPES, getProviderType }`；目标语言是两个自由输入框（`target-lang` / `target-lang-code`） |
| `extension/popup.html/js/css` | 两个按钮（翻译 / 还原）；读 `status` 显示当前服务；没有进度通道 |
| `types.d.ts` | `ProviderTypeId = 'openai' \| 'deepl'`；`ProviderConfig` 只有 `type`；`Settings` 只有 4 个字段 |
| `scripts/smoke.mjs` | 只 `import { getProviderType } from '../extension/lib/providers.js'`；stub `globalThis.fetch`；9 个用例 |
| `scripts/dom-smoke.mjs` | 最小假 DOM 加载真实 `content.js`；6 个用例；假 DOM 没有 `after` / `remove` / `innerText` / `querySelectorAll` / 属性存储 |
| `package.json` | `check: tsc -p .`、`smoke`、`smoke:dom`；devDependencies 只有 `typescript` + `@types/chrome` |
| `tsconfig.json` | `allowJs` + `checkJs` + `noEmit` + `strict`，`noImplicitAny: false`（故意），`include: extension/**/*.js + types.d.ts` |
| `README.md` | 写着“未实现：原文/译文对照”，与即将做的双语冲突；服务表只有 OpenAI 兼容 + DeepL |
| `AGENTS.md` | 写着“测试只有一个 provider 冒烟脚本”，已经与 `smoke:dom` 不符；本轮还要加 `build:glossary` |

### 1.2 必须保留的不变量

1. `background.js` 是唯一出网口、唯一读密钥的地方。设置页不直接 `fetch`，模型列表也走消息。
2. `translate()` 原序返回等长数组；数量不符直接抛错，绝不把译文错位写回 DOM。
3. 每轮翻译前先还原上一轮（`originals` 清空、`injected` 移除），否则第二轮会翻译译文。
4. 只有第 0 批失败才立即中止；其余批次计失败后继续。**新增熔断**：连续 3 批失败也停止，但保留已翻部分。
5. 注入 UI 只挂 `#sopen-translate-ui`，`pointer-events: none` 不改。
6. 无构建步骤、无运行时依赖（`typescript` + `@types/chrome` 之外不加包），浏览器直接加载 `extension/`。
7. `extension/content.js` 是 classic script，**不能出现 `import`**；需要共享代码就走消息或直接读 `chrome.storage`。
8. **`content.css` 的作用域例外**：`.sopen-translated-block` 是唯一允许出现在 `#sopen-translate-ui` 之外的规则；它必须挂在注入的译文 `span` 上，不能改成给宿主元素加内联 `all` 重置。
9. **语言单一来源**：`targetLang` / `targetLangCode` 由 `lib/languages.js` 的 10 项列表生成，popup 与设置页都从这里读写，不再各自维护一份。
10. **词库是构建产物**：`extension/lib/glossary-data.json` 只由 `npm run build:glossary` 生成，不手改；运行时只读，不联网。
11. **模型缓存不落草稿**：`models.list` 可以用设置页里的未保存配置发请求，但只能把缓存写回“已保存且配置一致”的 provider。
12. **测试不 import `background.js`**：service worker 依赖 `chrome.*`；冒烟测试只碰 `lib/*.js` 的纯函数与 `providers.js` 的 pipeline。

### 1.3 文件清单与依赖顺序

**新增**

| 文件 | 作用 |
| --- | --- |
| `extension/lib/http.js` | 超时、429 退避、`ProviderError`、`postJson` / `getJson` |
| `extension/lib/segments.js` | `parseSegments`（代码块 / null 段 / 数组） |
| `extension/lib/prompt.js` | 四套 LLM 协议共用的 system / repair prompt |
| `extension/lib/protocols.js` | 五种协议的 URL、鉴权、请求体、响应解析 |
| `extension/lib/provider-presets.js` | 12 个内置预设 + `custom` |
| `extension/lib/models.js` | `resolveModelsUrl` / `parseModelList` / `loadModelList` / `selectModels` |
| `extension/lib/glossary.js` | `loadGlossary` / `matchTerms` / `buildPromptLines` / `verifySegment` |
| `extension/lib/languages.js` | 10 项目标语言唯一来源 |
| `scripts/build-glossary.mjs` | 词库生成（手动、离线） |
| `scripts/glossary-allowlist.txt` | 人工维护的 DNT 词 |
| `scripts/glossary-blocklist.txt` | 通用词/误伤词排除 |
| `scripts/glossary-snapshot.json` | 上游筛选快照（入库） |
| `scripts/build-glossary-snapshot.mjs` | 维护者手动刷新快照（联网，不参与 build） |
| `THIRD-PARTY-NOTICES.md` | 第三方来源与许可 |

**修改**

| 文件 | 改动 |
| --- | --- |
| `types.d.ts` | 五种协议、`ProviderConfig`、`Settings`、`TranslateBatchResult` |
| `extension/lib/settings.js` | 默认值、迁移、`sessionId`、`getDisplayMode` / `setDisplayMode`、`patchProvider`、缓存合并 |
| `extension/lib/providers.js` | `getProviderType()` 兼容 + `translateBatch()` pipeline |
| `extension/background.js` | `models.list`、术语加载、session/UA 注入、`translate` 结果 |
| `extension/content.js` | 纯译文 / 双语双路径、还原、进度、`skipped` |
| `extension/content.css` | `.sopen-translated-block`（唯一作用域例外） |
| `extension/popup.html/js/css` | 圆形主按钮、模式切换、语言下拉、轮询进度 |
| `extension/options.html/js/css` | 预设管理、模型刷新、术语表、关于 |
| `extension/manifest.json` | 版本 0.2.0 |
| `scripts/smoke.mjs` | 协议 / 模型列表 / 术语 / 迁移用例 |
| `scripts/dom-smoke.mjs` | 假 DOM 扩展 + 双语用例 |
| `package.json` | `build:glossary` 脚本（不加依赖） |
| `README.md` / `AGENTS.md` | 功能、测试范围、许可、验证方式同步 |

**生成（入库，不手改）**

| 文件 | 由谁生成 |
| --- | --- |
| `extension/lib/glossary-data.json` | `npm run build:glossary` |

**依赖顺序**

1. A1 → A2 → A3 → A4 → A5 → A6 → A7；A7 之前不要动 UI。
2. B1 依赖 A1；B2 依赖 A5（`translate` 返回 `skipped`）与 A6（语言/模式）；B3/B4 依赖 B2；B5 最后跑。
3. C1 可独立先做；C2 依赖 C1 产物；C3 依赖 A4 + C2；C4 依赖 A6 + C2；C5 随 C1 的来源定稿；C6 最后跑。
4. D1 在 A/B/C 三套命令全绿后再改版本与文档。

---

# 阶段 A：provider 层

## A1 类型与存储

### 1. 新增/修改的类型（`types.d.ts`）

```ts
export type ProtocolId =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-gemini'
  | 'deepl';

export type EnforcementMode = 'fallback' | 'repair' | 'warn';
export type DisplayMode = 'translation' | 'bilingual';

export interface ModelsCache {
  at: number;
  list: string[];
  /** 产生这份缓存的 URL；baseUrl/modelsUrl 变了就失效 */
  forUrl: string;
}

export interface ProviderConfig {
  id: string;
  presetId: string;          // 'opencode-go' | 'openai' | ... | 'custom'
  protocol: ProtocolId;
  label?: string;
  baseUrl?: string;
  /** 可选覆盖；留空时按预设或 baseUrl 推导 */
  modelsUrl?: string;
  model?: string;
  apiKey?: string;
  modelsCache?: ModelsCache;
  /** 仅旧配置迁移时短暂存在，迁移后删除 */
  type?: 'openai' | 'deepl';
}

export interface Settings {
  schemaVersion: 2;
  targetLang: string;
  targetLangCode: string;
  activeProviderId: string | null;
  providers: ProviderConfig[];
  displayMode: DisplayMode;
  enforcement: EnforcementMode;
  glossary: { useBuiltin: boolean; terms: string[] };
  /** 每安装一个 UUID；OpenCode Go 的 x-opencode-session 用它 */
  sessionId: string;
}

export interface TranslateArgs {
  texts: string[];
  config: ProviderConfig;
  target: string;
  targetCode: string;
  glossary?: string[];
  enforcement?: EnforcementMode;
  /** 由 background 注入；例如 x-opencode-session */
  extraHeaders?: Record<string, string>;
  /** 测试用；默认 [1000, 4000, 10000] */
  retry?: { delays: number[] };
}

export interface TranslateBatchResult {
  translations: string[];
  /** 因术语保护保留原文的段数 */
  protected: number;
  /** 仅 warn 模式：哪些段可能漏了词 */
  warnings: { index: number; missing: string[] }[];
}

export interface ProtocolBuildArgs {
  texts: string[];
  config: ProviderConfig;
  target: string;
  targetCode: string;
  /** 本批注入 prompt 的术语（≤40） */
  terms?: string[];
  extraHeaders?: Record<string, string>;
  jsonMode?: boolean;
  repair?: boolean;
}

export interface Protocol {
  id: ProtocolId;
  label: string;
  buildRequest: (args: ProtocolBuildArgs) => {
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  parseResponse: (json: any) => string[];
  translate: (args: ProtocolBuildArgs & { retry?: { delays: number[] } }) => Promise<string[]>;
}
```

保留 `ProviderTypeId = 'openai' | 'deepl'` 与 `ProviderType` / `FieldSpec`，只给 `getProviderType()` 兼容入口用；不要再让新代码依赖 `type.fields`。

### 2. `lib/settings.js`

`DEFAULT_SETTINGS` 改成：

```js
export const DEFAULT_SETTINGS = {
  schemaVersion: 2,
  targetLang: '简体中文',
  targetLangCode: 'ZH-HANS',
  activeProviderId: null,
  providers: [],
  displayMode: 'translation',
  enforcement: 'repair',
  glossary: { useBuiltin: true, terms: [] },
  sessionId: '',
};
```

新增：

- `normalizeSettings(stored)`（纯函数）：补默认值，`glossary` 做嵌套合并，`providers` 逐项补 `protocol`/`presetId`；`protocol` 缺失时按 `getPreset(presetId).protocol` 补（`settings.js` 可以 import 纯数据 `provider-presets.js`），保证返回的 `Settings` 字段齐全。
- `migrateSettings(stored)`（纯函数，返回 `{ settings, changed }`）：**先**处理原始 `type`，**再**调 `normalizeSettings`；不要把顺序反过来，否则旧 `type` 会被默认值覆盖。
  - `schemaVersion < 2` 或缺失时执行；
  - `{type:'openai'}` → `{presetId:'custom', protocol:'openai-chat'}`；`{type:'deepl'}` → `{presetId:'deepl', protocol:'deepl'}`；保留 `id`/`label`/`baseUrl`/`model`/`apiKey`；
  - `targetLangCode === 'ZH'` → `'ZH-HANS'`（DeepL 同样接受，属于无损迁移）；
  - `type` 字段迁移后删除；
  - 重复执行必须无变化（幂等）。
- `getSettings()`：读出后跑 `migrateSettings`；`changed` 为真时**await 写回一次**，再返回。
- `saveSettings(patch)`：`{ ...(await getSettings()), ...patch }`；如果 `patch.glossary` 存在，和当前 `glossary` 合并，避免只传一半把 `useBuiltin` 冲掉。
- `getSessionId()`：读 `settings.sessionId`；为空时 `crypto.randomUUID()` 生成并用 `saveSettings({ sessionId })` 落盘，再返回。**不要**把生成逻辑塞进 `getSettings()`，否则每次读取都可能写盘。
- `patchProvider(id, patch)`：重新读 settings，按 id 找到 provider，合并 patch 后保存；返回更新后的 provider。`models.list` 写缓存用它，避免拿旧草稿覆盖别的字段。
- `mergeProviderCaches(draft, stored)`：保存设置时，如果 `stored.providers[i].modelsCache.at > draft.providers[i].modelsCache?.at`，保留 stored 的缓存。防止设置页打开期间后台刷新了模型列表、用户点保存又把它冲掉。

### 3. 语言迁移

- 新装默认 `简体中文` / `ZH-HANS`。
- 老用户如果 `targetLang` 不在 `LANGUAGES` 里（例如“文言文”），**不要静默改成简体中文**；设置页与 popup 的 `<select>` 追加一个只读的 `当前：<值>（不在列表）` 选项，用户主动选别的语言时才覆盖。
- `targetLangCode` 只迁移 `ZH`；其他值保留。

### 4. `lib/languages.js`（新增）

popup 与设置页的唯一语言来源：

```js
export const LANGUAGES = [
  { id: 'zh-Hans', name: '简体中文', code: 'ZH-HANS' },
  { id: 'zh-Hant', name: '繁体中文', code: 'ZH-HANT' },
  { id: 'ja', name: '日语', code: 'JA' },
  { id: 'ko', name: '韩语', code: 'KO' },
  { id: 'en', name: '英语', code: 'EN-US' },
  { id: 'fr', name: '法语', code: 'FR' },
  { id: 'de', name: '德语', code: 'DE' },
  { id: 'es', name: '西班牙语', code: 'ES' },
  { id: 'ru', name: '俄语', code: 'RU' },
  { id: 'pt', name: '葡萄牙语', code: 'PT-BR' },
];

export function findLanguage(nameOrCode) { ... }
```

- DeepL 使用 `code`；LLM prompt 使用 `name`。
- 英语用 `EN-US`、葡萄牙语用 `PT-BR`（DeepL 推荐带地区；`EN` / `PT` 泛代码不再使用）。
- `findLanguage` 按 `name` 或 `code` 查找，供回显老值用。

---

## A2 基础设施

### 1. `lib/http.js`（新增）

从现有 `providers.js` 抽出来，并补上超时与 429：

```js
export class ProviderError extends Error {
  constructor(message, status) { ... this.status = status; }
}
export function fail(message, status) { throw new ProviderError(message, status); }
export function messageOf(err) { ... }
export function clip(text, max = 240) { ... }
export function joinUrl(base, path) { ... }   // 去掉多余斜杠
export async function postJson(url, { headers, body, timeoutMs = 30000, retryDelays = [1000, 4000, 10000] } = {}) { ... }
export async function getJson(url, { headers, timeoutMs = 8000 } = {}) { ... }
```

`postJson` 规则：

- 用 `AbortController` + `setTimeout` 做超时（不要依赖 `AbortSignal.timeout` 的 lib 类型）；超时抛 `ProviderError('请求超时（…ms）')`。
- 只有 `429` 进入退避重试：按 `retryDelays` 依次等待，最多重试 `retryDelays.length` 次；测试传 `retry: { delays: [0,0,0] }`，`postJson` 内部仍用真实 `setTimeout`（0ms，足够快）。
- 401 / 403 / 其他 5xx 不重试，直接抛 `ProviderError('HTTP <status>：…')`，并把 `status` 挂在 error 上。
- 连接失败 → `ProviderError('无法连接 <url>：…')`。
- 非 JSON → `ProviderError('响应不是合法 JSON：…')`。

`getJson` 用于模型列表：不重试 429，8 秒超时，非 2xx 抛 `ProviderError`。

`ProviderError` 的 `status` 用 JSDoc 标成 `number | undefined`，否则 `checkJs` 会在 `err.status` 处报错。

### 2. `lib/segments.js`（新增）

把 `parseSegments(content)` 从 `providers.js` 挪出来，保持兼容：

- 依次尝试原文、带 `json` 标记的代码块、第一个 `{` 到最后一个 `}`；
- 支持顶层数组或 `{segments:[...]}`；
- `null` / `undefined` 映射成 `''`（表示模型拒绝该段），其他值 `String(...)`；
- 解析不到就抛 `ProviderError('无法解析模型返回：…')`。

### 3. `lib/prompt.js`（新增）

四套 LLM 协议共用，避免在每个协议里复制 prompt：

```js
export function buildSystemPrompt(target, terms = []) { ... }
export function buildRepairSystemPrompt(target, terms = []) { ... }
export function buildUserPayload(texts) { ... }   // JSON.stringify({ segments: texts })
```

`buildSystemPrompt` 在现有 `SYSTEM_PROMPT(target)` 后追加（有命中术语时）：

```
以下词是专有名词/品牌/技术名，必须原样出现在译文里：<逐行列出>
不得翻译、不得音译、不得加括号注解。译文中若无法保留，对应段返回 null。
形如「品牌名 + 版本号」的字符串（如 GPT-5、DeepSeek V4.1 Flash）同样不得翻译。
```

`buildRepairSystemPrompt` 用于第二次只重发失败段：明确“上一轮遗漏了这些词”，要求只返回 JSON，长度与输入一致。

**注意**：prompt 里必须保留 "JSON" 字样（`deepseek-v4.1-flash` 的 `response_format` 检查依赖它）。

### 4. `lib/protocols.js`（新增）

每个协议导出 `{ id, label, buildRequest(args), parseResponse(json), translate(args) }`。`buildRequest` / `parseResponse` 只做协议翻译，不知道厂商；`translate` 是单次请求（含 `openai-chat` 的 `response_format` 回退），不含术语校验、不含 429 重试（429 在 `http.js`）。

```js
buildRequest({ texts, config, target, targetCode, terms, extraHeaders, jsonMode, repair })
  → { url, headers, body }          // 完整 url
parseResponse(json) → string[]      // 各协议取文本后交给 parseSegments
```

- `openai-chat`：`POST {baseUrl}/chat/completions`，`Authorization: Bearer`（有 key 时），`messages[system,user]`；先带 `response_format:{type:'json_object'}`，**只在 `err.status === 400 || 404 || 422`** 时去掉该字段重试一次。`extraHeaders` 合并到请求头（OpenCode Go 的 `x-opencode-session`）。
- `openai-responses`：`POST {baseUrl}/responses`，body 用 `input` 数组，取 `output[].content[].text` 拼接后走 `parseSegments`。
- `anthropic-messages`：`POST {baseUrl}/messages`，头 `x-api-key` + `anthropic-version: 2023-06-01`，`max_tokens: 4096`，取 `content[].text`。
- `google-gemini`：`POST {baseUrl}/models/{model}:generateContent?key=...`，body `contents`，取 `candidates[0].content.parts[].text`。
- `deepl`：把现有实现整体挪进来，保持 `text` / `target_lang` 行为不变；忽略 `terms` / `repair`。

`extraHeaders` 只由 `background.js` 注入；协议层不读 `chrome.storage`。`User-Agent` 可以放进 extraHeaders，但**不要把它当成必需**。

---

## A3 预设与模型

### 1. `lib/provider-presets.js`（新增，纯数据）

```js
export const PROVIDER_PRESETS = [
  { id: 'opencode-go', label: 'OpenCode Go', protocol: 'openai-chat',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    modelsUrl: 'https://opencode.ai/inference/go/v1/models',   // 与 baseUrl 不同，实测
    models: ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3', 'glm-5.3-flash', 'kimi-k3', 'gpt-5.6-luna'],
    supportsModelList: true, requiresSession: true, verified: true,
    hint: '需要 API Key；扩展会自动生成并带上 x-opencode-session。' },

  { id: 'openai', label: 'OpenAI', protocol: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-luna'],
    supportsModelList: true, verified: false,
    hint: '接口未实测；baseUrl/模型名以官方文档为准。' },

  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    supportsModelList: true, verified: false },

  { id: 'sensenova', label: '商汤 SenseNova', protocol: 'openai-chat',
    baseUrl: 'https://token.sensenova.cn/v1',
    models: ['sensenova-6.8-flash-lite', 'deepseek-v4.1-flash'],
    supportsModelList: true, verified: true,
    hint: 'RPM 较低；扩展会自动退避重试。' },

  { id: 'kimi', label: 'Kimi（中国站）', protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3', 'kimi-k2.6'],
    supportsModelList: true, verified: false },

  { id: 'kimi-global', label: 'Kimi（国际站）', protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k3'],
    supportsModelList: true, verified: false },

  { id: 'zhipu', label: '智谱 GLM', protocol: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2'],
    supportsModelList: true, verified: false },

  { id: 'dashscope', label: '阿里百炼', protocol: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-flash', 'qwen-flash', 'qwen3.5-plus'],
    supportsModelList: true, verified: false },

  { id: 'minimax', label: 'MiniMax', protocol: 'openai-chat',
    baseUrl: 'https://api.minimax.io/v1',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    supportsModelList: true, verified: false,
    hint: '国际站用 api.minimax.io；中国站可能需要 api.minimaxi.com，未实测。' },

  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openrouter/auto', 'openai/gpt-5.2'],
    supportsModelList: true, verified: false },

  { id: 'siliconflow', label: '硅基流动', protocol: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V4-Flash', 'moonshotai/Kimi-K2.6'],
    supportsModelList: true, verified: false },

  { id: 'deepl', label: 'DeepL', protocol: 'deepl',
    baseUrl: 'https://api-free.deepl.com', models: [],
    supportsModelList: false, verified: true,
    hint: '不支持术语保护；免费版用 api-free，付费版用 api.deepl.com。' },

  { id: 'custom', label: '自定义', protocol: 'openai-chat',
    baseUrl: '', models: [], supportsModelList: true, verified: false,
    hint: 'OpenAI 兼容接口；本地 Ollama / One-API 可以不填 API Key。' },
];

export const PRESET_BY_ID = Object.fromEntries(PROVIDER_PRESETS.map(p => [p.id, p]));
export function getPreset(id) { return PRESET_BY_ID[id] || PRESET_BY_ID.custom; }
```

> `models` 是“拿不到列表时的兜底建议”，允许过期；`supportsModelList` 只控制是否**自动**尝试拉取，用户点“刷新”仍可试。`verified: false` 的卡片必须显示“接口未实测”。

### 2. `lib/models.js`（新增，纯函数 + 一个 fetch 包装）

```js
export function resolveModelsUrl(config) {
  const preset = getPreset(config.presetId);
  if (config.modelsUrl) return config.modelsUrl;
  if (preset.modelsUrl && (!config.baseUrl || config.baseUrl === preset.baseUrl)) return preset.modelsUrl;
  return config.baseUrl ? joinUrl(config.baseUrl, '/models') : '';
}

export function parseModelList(json)       // 容错 4 种形状，返回去重排序后的 string[]
export async function fetchModelList({ url, apiKey, timeoutMs = 8000 })
export async function loadModelList({ config, preset, timeoutMs = 8000 })
  // → { models: string[], from: 'network' | 'preset' }；失败/空列表不抛错，回退 preset.models
```

`loadModelList` 把“请求 + 空列表判定 + 回退”包在一起，background 只负责缓存与写盘；这样 A7 可以直接 stub `fetch` 测回退，而不需要 import `background.js`。

`models.js` 顶部只依赖两个纯模块：

```js
import { getPreset } from './provider-presets.js';
import { getJson, joinUrl } from './http.js';
```

`parseModelList` 必须支持：

- `{ data: [{ id }] }`（OpenAI / 商汤 / Anthropic）
- `{ data: [{ name }] }`
- `{ models: [{ name }] }`（Google）
- `{ models: [{ id }] }`
- 顶层数组：字符串或 `{id|name}`
- 其他形状 → 返回 `[]`（调用方据此走预设兜底）

取到的值 `trim`、去空、去重（精确匹配，模型 id 大小写有意义）、排序。不做“猜哪些是聊天模型”的过滤——宁可让用户看到 embedding 模型并测试失败，也不要静默藏掉可用模型。

---

## A4 `lib/providers.js` 重构

### 1. 保留兼容入口

```js
export function getProviderType(id) → ProviderType
```

- `'openai'`：返回薄包装，`protocol: 'openai-chat'`，`translate` 走 `translateBatch({ glossary: [], enforcement: 'warn' })`；调用前把旧 config 补成 `{ ...config, protocol: 'openai-chat' }`；
- `'deepl'`：返回薄包装，`protocol: 'deepl'`；调用前补 `{ ...config, protocol: 'deepl' }`；
- `'openai-chat'` / `'openai-responses'` / `'anthropic-messages'` / `'google-gemini'` / `'deepl'`：直接返回协议适配对象；
- 未知 id 抛错。

**不要删旧别名**，否则 `scripts/smoke.mjs` 的现有 9 个用例全废；但新代码（background/options）不要再依赖 `PROVIDER_TYPES`。`providers.js` 继续 `export { ProviderError } from './http.js'`，避免旧调用方断掉。

### 2. 新增 `translateBatch()`

```js
/**
 * @param {TranslateArgs} args
 * @returns {Promise<TranslateBatchResult>}
 */
export async function translateBatch({ texts, config, target, targetCode, glossary = [], enforcement = 'repair', extraHeaders, retry }) { ... }
```

流程：

1. 取协议实现；`deepl` 直接 `protocol.translate(...)`，做等长校验后返回 `{ translations, protected: 0, warnings: [] }`（术语层完全跳过）。
2. 用 `compileGlossary(glossary)` 编译一次（模块级缓存，按词表 join 的 key 命中）。
3. 对每段跑 `matchTerms(text, compiled)`，得到命中；合并去重后取前 40 条作为本批 `termsForPrompt`。
4. `protocol.translate({ texts, config, target, targetCode, terms: termsForPrompt, extraHeaders, retry })`。
5. 等长校验；然后对每段用 **`termsForPrompt`** 作为 `allowed` 做 `verifySegment`（不要用完整词表校验，否则模型没被要求保留的截断词也会导致回退）。
6. 按 `enforcement` 处理：
   - `fallback`：缺词的段直接替换成原文，`protected++`；
   - `warn`：保留译文，`warnings.push({ index, missing })`，不增加 `protected`；
   - `repair`：把缺词段的下标收集起来，只重发这些段（`texts: subset`，`terms: 这些段缺失的词`，`repair: true`），最多一次；第二次仍缺词的段替换成原文并 `protected++`。
7. 返回 `{ translations, protected, warnings }`；`translations.length === texts.length` 永远成立。

修复请求的长度也必须校验；数量不符时把这次修复视为全失败，相关段全部回退原文。

---

## A5 `background.js`

### 1. 消息表

| 消息 | 请求 | 响应 |
| --- | --- | --- |
| `translate` | `{ texts: string[] }` | `{ ok, translations, protected, warnings }` |
| `testProvider` | `{ config, sample? }` | `{ ok, result, elapsed, provider }` |
| `status` | 无 | `{ ok, providerCount, active, targetLang, displayMode, enforcement }` |
| `models.list` | `{ provider: ProviderConfig }` | `{ ok, models, from: 'cache'\|'network'\|'preset', cached: boolean }` |

### 2. `translate`

- `normalizeTexts` 保持；
- `const { settings, provider } = await getActiveProvider()`；没有 provider 抛“还没有配置翻译服务”；
- `const terms = await getGlossaryTerms(settings)`（见 C2）：内置 JSON + 用户词；加载失败只记 `console.warn`，退化为用户词，不阻断翻译；
- 如果 `getPreset(provider.presetId).requiresSession`，`const sessionId = await getSessionId()`，`extraHeaders['x-opencode-session'] = sessionId`；
- `const result = await translateBatch({ texts, config: provider, target: settings.targetLang, targetCode: settings.targetLangCode, glossary: terms, enforcement: settings.enforcement, extraHeaders })`；
- 返回 `{ ok: true, translations: result.translations, protected: result.protected, warnings: result.warnings }`。

`testProvider` 复用同一条路径，但 `glossary: []`、`enforcement: 'warn'`，并且同样注入 session 头；否则 OpenCode Go 的“测试”按钮永远 400。

### 3. `models.list`

1. 取 `provider`（草稿）；`getPreset(provider.presetId)`。
2. 如果 `provider.protocol !== 'openai-chat'` 或 `!preset.supportsModelList`：返回 `{ ok: true, models: preset.models, from: 'preset', cached: false }`。
3. 读已保存的 provider（按 id）；如果它的 `modelsCache` 在 7 天内且 `forUrl === resolveModelsUrl(provider)`：返回 `from: 'cache'`，`cached: true`。
4. `const { models, from } = await loadModelList({ config: provider, preset, timeoutMs: 8000 })`。
5. 如果 `from === 'network'` 且 `models.length > 0`：
   - 如果已保存的 provider 存在，且 `baseUrl` / `modelsUrl` / `apiKey` 与草稿一致，`patchProvider(id, { modelsCache: { at: Date.now(), list: models, forUrl } })`，`cached: true`；
   - 否则不写盘，`cached: false`（设置页提示“用草稿配置获取，保存后可缓存”）。
6. 如果 `from === 'preset'`（失败/超时/结构不认识/空列表）：**不抛错**，返回 `{ models, from: 'preset', cached: false }`。

>`models.list` 永远返回 `ok: true`；真正的鉴权错误交给“测试”按钮，避免用户一按刷新就看到红字。

### 4. `status`

```js
return {
  ok: true,
  providerCount: settings.providers.length,
  active: provider ? { label: provider.label || getPreset(provider.presetId).label, presetId: provider.presetId, protocol: provider.protocol } : null,
  targetLang: settings.targetLang,
  displayMode: settings.displayMode,
  enforcement: settings.enforcement,
};
```

### 5. 词库缓存

`background.js` 模块级缓存 `{ key, terms }`；key 用 `useBuiltin + '\u0000' + terms.join('\u0000')`。监听 `chrome.storage.onChanged`，`settings` 变化时清空。service worker 重启后自然重建。

---

## A6 设置页

### 1. `options.html`

- 服务区：`#providers`、`#provider-count`、`#add-preset`、`#add`；
- 目标语言区：`#target-lang`（`<select>`），删除 `#target-lang-code` 输入框；语言代码由 `LANGUAGES` 自动带出；
- 术语表区：`#use-builtin`、`#glossary-terms`（textarea）、`#enforcement`（select）、`#glossary-meta`、`#enforcement-help`；
- 关于区：`#app-version`、许可列表。

### 2. provider 卡片

- 顶部：服务名称输入、预设 badge、`未实测` badge（`verified === false`）、默认 radio。
- 字段：
  - `API Key`（`type=password`）：内置云服务必填；`custom` 可空（本地 Ollama / One-API）。
  - `模型`：`<select>` + `刷新` 按钮 + “手动输入”切换。选项来自 `provider.modelsCache?.list`（未过期）或 `preset.models`；当前 `model` 不在列表时也要保留一项。`protocol === 'deepl'` 时隐藏该字段。
  - `自定义 baseUrl`：`<details>`，默认收起；展开后写 `provider.baseUrl`。改了 baseUrl 时清空 `modelsCache`。
  - `自定义 modelsUrl`：只在 `custom` 或“高级”里显示；留空按 `resolveModelsUrl` 推导。
  - `协议`：只在 `custom` 显示，5 个选项。
- 操作：`测试` / `删除` / `设为默认`。
- 未实测提示：卡片底部一行小字，来自 `preset.hint`。

### 3. 添加服务

`#add-preset` 用 `<optgroup>` 分组：

- `已验证`：OpenCode Go、商汤、DeepL；
- `接口未实测`：OpenAI、DeepSeek、Kimi 中国站、Kimi 国际站、智谱、阿里百炼、MiniMax、OpenRouter、硅基流动；
- `自定义`。

新增对象：

```js
{
  id: crypto.randomUUID(),
  presetId: preset.id,
  protocol: preset.protocol,
  label: preset.label,
  baseUrl: preset.baseUrl,
  model: preset.models[0] || '',
  // 不预填 modelsCache，等刷新
}
```

同类服务重复添加时，`label` 追加序号（`OpenCode Go 2`），沿用现有 `used` 计数；用户仍可改。

### 4. 模型刷新

- `API Key` 的 `change` 且长度 > 8 时自动触发一次；也可以点“刷新”。
- 调 `chrome.runtime.sendMessage({ type: 'models.list', provider })`。
- 成功：更新 `provider.modelsCache = { at: Date.now(), list, forUrl }`（只在本地 draft；后台负责是否落盘），重渲染模型下拉；`from === 'preset'` 时显示“接口没返回列表，使用预设建议”。
- 失败：静默降级到预设，不弹错。
- 如果 `cached === false`，显示“已用草稿配置获取；保存后再刷新可缓存”。

### 5. 必填校验

| 类型 | 必填 |
| --- | --- |
| 内置 LLM 预设 | `apiKey`、`model` |
| DeepL | `apiKey`、`baseUrl` |
| `custom` + `openai-chat` / 其他 LLM 协议 | `protocol`、`baseUrl`、`model`；`apiKey` 可空 |
| `custom` + `deepl` | `protocol`、`baseUrl`、`apiKey` |

### 6. 术语表与语言

- 内置开关写 `settings.glossary.useBuiltin`。
- 多行文本域：一行一个词，空行忽略，保存时 trim + 去重（大小写不敏感，保留首次写法）。
- `#enforcement` 三个选项，文案必须写清后果：
  - `fallback`：`漏词就整段保留原文。最保守，可能出现成片未翻译。`
  - `repair`：`先只重翻漏词段，仍漏才保留原文。默认。`
  - `warn`：`译文照常显示，只在结果里提示可能漏词。最流畅。`
- 切换时同步更新 `#enforcement-help`，不要只靠 `<option>` 的短标签。
- 内置词库信息：`fetch(chrome.runtime.getURL('lib/glossary-data.json'))`，显示条数与 `generatedAt`；失败显示“内置词库尚未生成，先跑 npm run build:glossary”。
- 目标语言 `<select>` 用 `LANGUAGES`；老值不在列表时追加只读“当前：X（不在列表）”。

### 7. 保存

- 保存前用 `mergeProviderCaches(draft, stored)` 保留后台刚刷新的缓存。
- 只提交设置页负责的字段，不要整份 `draft` 覆盖：

```js
const patch = {
  providers: draft.providers,
  activeProviderId: draft.activeProviderId,
  targetLang: selected.name,
  targetLangCode: selected.code,
  enforcement: /** @type {import('../types').EnforcementMode} */ (enforcementEl.value),
  glossary: {
    useBuiltin: useBuiltinEl.checked,
    terms: normalizeTerms(termsEl.value.split('\n')),
  },
};
state.draft = await saveSettings(patch);
```

- `displayMode` / `sessionId` 不在这份 patch 里：`displayMode` 由 popup 管，`sessionId` 由 `getSessionId()` 管。
- 成功后重新渲染，`modelsCache` 以保存后的为准。

---

## A7 验收 A

`scripts/smoke.mjs` 改成可执行清单（保留现有 9 个用例，新增 15 个左右）：

1. `openai` 兼容入口：正常返回，顺序与长度保持。
2. 代码块包裹的 JSON。
3. `response_format`：400 时去掉字段重发一次，总调用 2 次。
4. **401 时不触发 `response_format` 回退**，总调用 1 次。
5. 分段数不符抛错。
6. 无法解析抛错。
7. HTTP 401 透出状态码。
8. 连接失败给出可读错误。
9. `anthropic-messages` 解析 `content[].text`。
10. `google-gemini` 解析 `candidates[0].content.parts`。
11. `openai-responses` 解析 `output[].content[].text`。
12. `deepl` 正常返回 + 数量不符。
13. `parseModelList` 解析 4 种形状：`{data:[{id}]}`、`{data:[{name}]}`、`{models:[{name}]}`、顶层数组；去重排序。
14. `loadModelList` 网络失败/空列表 → 返回 `preset.models` 且不抛错。
15. `resolveModelsUrl`：OpenCode Go 返回 `.../v1/models`（不是 `.../openai/v1/models`）。
16. `openai-chat` + `requiresSession`：断言请求头里有 `x-opencode-session`，值等于传入的 sessionId；断言只带这个头也能构造请求（不要求 `User-Agent`）。
17. 429 退避：stub 前两次 429、第三次 200，`retry: { delays: [0,0,0] }`，断言成功且 3 次调用。
18. 429 连续失败（默认 1 次初始 + 3 次重试）：抛 `HTTP 429`，不触发 `response_format` 回退（总调用 4 次，不是 8 次）。
19. pipeline 术语注入：`glossary:['Kubernetes']`，源文本含 `Kubernetes`，断言请求 body 的 system prompt 含该词。
20. pipeline fallback：模型返回缺词译文 → 该段替换成原文，`protected === 1`。
21. pipeline repair：第一次缺词，第二次（只含失败段）补齐 → 最终保留译文，`protected === 0`，第二次请求的 segments 只含失败段。
22. pipeline warn：缺词 → 译文保留，`warnings[0].missing` 含该词，`protected === 0`。
23. DeepL + glossary：不注入、不校验，`protected === 0`。
24. 型号正则：`GPT-5`、`V4.1`、`M3.1` 命中；`DeepSeek V4.1 Flash` 由 allowlist 整串命中（正则只保证 `V4.1` 子串）。
25. 40 条上限：源文本命中 45 个术语，prompt 只列 40 条，校验也只针对这 40 条。
26. `migrateSettings`：旧 `{type:'openai'}` / `{type:'deepl'}` 迁移；`ZH` → `ZH-HANS`；重复执行无变化。

命令：

```powershell
npm run check
npm run smoke
```

零错误、零失败。`scripts/smoke.mjs` 只 import `lib/*.js` 与 `providers.js`，不 import `background.js`。

---

# 阶段 B：渲染双路径

## B1 存储

- `settings.displayMode`（A1 已加），默认 `translation`。
- popup 的切换立即 `saveSettings({ displayMode })`。
- `page.translate` 消息**不带模式**；content 每次从 `chrome.storage.local` 读 `settings.displayMode`，读不到就按 `translation`。
- content 与 popup 都不缓存模式到模块级全局；每次翻译以存储为准。

## B2 `content.js` 重构

### 1. 结构

```js
const state = {
  mode: 'translation',
  originals: [],        // { node, text }，纯译文用
  injected: [],         // span，双语用
  busy: false,
  progress: { done: 0, total: 0 },
};
```

把 `SELECT` / `OPTION` 补进现有 `SKIP_TAGS`，避免翻译表单下拉选项；纯译文与双语共用这份跳过集合。

函数：

```js
function collectTextNodes(root)                       // 现有实现，纯译文用
function collectBlocks(root) → { el, text }[]         // 双语用
function splitLongText(text, max = 1200) → string[]   // 按句切
function buildSegments(blocks) → { text, blockIndex, chunkIndex }[]
function batchSegments(segments) → Segment[][]        // 1200 字符 / 20 段
function applyTextTranslations(nodes, translations)   // 纯译文写回
function applyBlockTranslations(blocks, translationsBySegment) // 双语插入
function resetPage()                                  // 移除 injected + 还原 originals + 清 progress
```

### 2. 纯译文

沿用现有逻辑：

- `node.nodeValue = from.replace(from.trim(), next.trim())`；
- `originals.push({ node, text: from })`；
- 不碰 `<a>` 元素本身，只改它的文本子节点 → 链接仍可点、样式继承；
- 每批拿到译文后立即写回（保持现有“边翻边出”的观感）。

### 3. 双语块收集 `collectBlocks`

候选标签：

```js
const BLOCK_TAGS = new Set(['P','LI','H1','H2','H3','H4','H5','H6','TD','TH','DD','DT','BLOCKQUOTE','FIGCAPTION']);
const LEAF_CONTAINER_TAGS = new Set(['DIV','SECTION','ARTICLE','MAIN']);
const BLOCKISH_TAGS = new Set([
  'DIV','SECTION','ARTICLE','MAIN','P','LI','UL','OL','TABLE','THEAD','TBODY','TFOOT','TR','TD','TH',
  'H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','FIGURE','FORM','NAV','HEADER','FOOTER','ASIDE','DL','DT','DD',
]);
```

判定：

1. 跳过 `SKIP_TAGS` 内或其后代、`#sopen-translate-ui`、`contenteditable`、`hidden`、`aria-hidden="true"`（自身或祖先）。
2. 跳过包含 `PRE` / `CODE` / `KBD` / `SAMP` / `TEXTAREA` / `INPUT` / `SELECT` / `OPTION` / `SVG` / `CANVAS` / `IFRAME` / `OBJECT` 后代的块（含内联 `<code>` 的段落也跳过；这是有意的覆盖率损失，换“不把代码翻坏”）。
3. 跳过包含 `.sopen-translated-block` 的块（防止下一轮把译文当原文）。
4. 标签在 `BLOCK_TAGS` 里 → 候选；标签在 `LEAF_CONTAINER_TAGS` 里 → 只有“没有 `BLOCKISH_TAGS` 后代”且 `innerText` 长度 ≥ 40 时才算候选。
5. 如果候选内部还包含另一个候选（例如 `<li><p>…</p></li>`）→ 父级不作为单位，交给子级。
6. 文本：`el.innerText`（没有则 `textContent`），NBSP 换成普通空格，`trim()`；长度 < 2 或没有 `\p{L}\p{N}` → 跳过。
7. 按文档顺序返回。

> `innerText` 会触发布局；候选块数量通常远小于文本节点数，先按这个实现。如果四页验收发现 Wikipedia 明显卡顿，再退回 `textContent` + 跳过隐藏属性，并在计划里记一笔。

### 4. 插入

```js
const span = document.createElement('span');
span.className = 'sopen-translated-block';
span.setAttribute('data-sopen-translated', '');
span.style.display = 'block';        // 防宿主页 span{display:inline}
span.textContent = translatedText;
block.el.append(span);               // 不用 el.after，表格/列表安全
state.injected.push(span);
```

- `append` 不存在时退回 `appendChild`。
- 一段（block）对应一个 `span`；长块切出来的多个 chunk 拼成一个 `span`，用 `joinChunks()` 拼接（CJK 句末不加空格，拉丁句末加空格）。
- 如果拼出来的译文 `trim()` 后为空、或与原文 `trim()` 相同 → **不插入**（避免术语回退时在原文下面复制一份原文）。

### 5. 长块切分

`splitLongText(text, max=1200)`：

- 优先在 `[。！？!?;；]\s*` 或换行处切；
- 逐段累加，超过 `max` 就开新 chunk；
- 单句本身超过 `max` 时硬切；
- 返回的 chunk 都 `trim()`，丢掉空串；
- 只有一个 chunk 时原样返回。

`buildSegments` 给每个 chunk 记 `{ text, blockIndex, chunkIndex }`；`batchSegments` 仍按 1200 字符 / 20 项切批。**单个 chunk 不超过 1200**，所以不会出现单段超预算。

### 6. 翻译主流程

```js
async function translatePage() {
  if (busy) return { ok: false, error: '正在翻译中' };
  resetPage();
  state.mode = await readDisplayMode();
  if (state.mode === 'bilingual') return translateBilingual();
  return translateTextMode();
}
```

共同规则：

- `requestTranslate(texts)` 返回 `{ translations, protected, warnings }`；消息没有 `ok` 或长度不符就转成异常；
- 只有第 0 批失败才立即中止；
- 连续 3 批失败 → `stopped = true`，停止后续批次，保留已翻部分；
- toast 文案带模式：`翻译中（双语）3/20…`；
- 返回 `{ ok, translated, failed, protected, stopped? }`；
- 计数单位不完全一致：`translated` 纯译文按文本节点、双语按插入的块；`protected` / `failed` 按送翻段（chunk）。长块被切时两个数字可能不是同一粒度，文案不要写成严格的加减关系；
- `warn` 模式的 `warnings` 不进 `protected`，content 用 `warnings.length` 在 toast 里汇总“m 段可能未保留术语”；`protected` 只统计 fallback/repair 回退的段；
- `page.status` 返回 `{ ok, translated, busy, mode, progress }`。

纯译文：

- `collectTextNodes()` → `batchNodes()`（现有 1200/20）→ 每批 `requestTranslate()` → 立即写回；
- `translated` 按实际写入的文本节点计数；
- `protected` 累加 background 返回值。

双语：

- `collectBlocks()` → `buildSegments()` → `batchSegments()`；
- 用 `Array(segments.length)` 收集每段译文；批失败的位置留空；
- 全部批次结束（或熔断）后，按 block 检查：该 block 的所有 chunk 都有非空译文才插入；否则跳过该 block（已计入 failed/protected）；
- `translated` 按插入的 block 数计数；
- 如果 `protected` 段回退成原文，插入阶段会因“与原文相同”而跳过，不会出现重复原文。

还原：

```js
function resetPage() {
  for (const el of state.injected) el.remove?.();
  state.injected = [];
  for (const { node, text } of state.originals) node.nodeValue = text;
  state.originals = [];
  state.progress = { done: 0, total: 0 };
}
```

`restorePage()` 在 `busy` 时拒绝；返回 `{ ok: true, restored }`，`restored` = 移除的 span 数 + 回填的文本节点数。

### 7. 消息入口

| 消息 | 行为 |
| --- | --- |
| `page.translate` | `translatePage().then(sendResponse)` |
| `page.restore` | `sendResponse(restorePage())` |
| `page.status` | `sendResponse({ ok:true, translated, busy, mode, progress })` |

`translated`：纯译文 = `originals.length`；双语 = `injected.filter(el => el.isConnected !== false).length`。

`progress`：`{ done, total }`，`done` 按已处理段数累加；翻译结束后保留 `{ done: total, total }`，还原时清零。

---

## B3 `content.css`

```css
/*
 * 唯一一条作用域例外：译文块必须挂在宿主页面的块元素里，
 * 不能塞进 #sopen-translate-ui。类名带 sopen- 前缀，避免和宿主样式撞车。
 */
.sopen-translated-block {
  display: block;
  margin: .25em 0 .5em;
  color: inherit;
  font-size: inherit;
  line-height: 1.6;
  opacity: .88;
  white-space: pre-line;
}
```

- 不写 `!important`；
- 不改 `#sopen-translate-ui` 的 `pointer-events`；
- `span.style.display = 'block'` 是 JS 里的保险，CSS 仍保留 `display:block` 给没有 JS 的静态检查看；
- 更新 README/AGENTS 里“全部样式限定在 `#sopen-translate-ui`”的说法，改成“浮层样式限定；译文块是唯一例外”。

---

## B4 popup

### 1. `popup.html`

```html
<button id="main" class="round" aria-label="翻译此页">翻译</button>

<div class="mode" role="group" aria-label="展示模式">
  <button type="button" data-mode="translation" aria-pressed="true">纯译文</button>
  <button type="button" data-mode="bilingual" aria-pressed="false">双语</button>
</div>

<select id="target-lang" aria-label="目标语言"></select>
<p id="message" class="muted" role="status"></p>
<footer>
  <a id="open-options" href="#">设置</a>
  <span id="provider"></span>
</footer>
```

### 2. 行为

- 打开时 `getSettings()`：回显 `displayMode` 与 `targetLang`；`status` 取当前 provider；`page.status` 取当前页状态。
- 主按钮：
  - 无 provider → 禁用，文案“翻译”；
  - 页面不支持 → 禁用，提示“这个页面不支持翻译”；
  - `busy` → 禁用，显示 `progress.done/progress.total`；
  - `translated > 0` → 文案“还原”；
  - 否则 → “翻译”。
- 点击“翻译”：发送 `page.translate`，同时每 500ms 轮询 `page.status`（用 `polling` 标志防止请求堆叠）；`finally` 清掉定时器。
- 点击“还原”：发送 `page.restore`，刷新状态。
- 模式切换：`saveSettings({ displayMode })`；如果当前页 `translated > 0`，提示“已切换；点『还原』后重新翻译生效”，**不要自动重翻**。
- 语言下拉：选项来自 `LANGUAGES`；`change` 时写 `targetLang` + `targetLangCode`；已翻译页面提示“下次翻译生效”。
- `busy` 时禁用主按钮、模式切换、语言下拉：background 是每批读一次 settings，中途改语言会让同一页前后批次用不同目标语言。
- 自定义老值：如果 `settings.targetLang` 不在 `LANGUAGES`，下拉追加只读项 `当前：X（不在列表）`，默认选中。
- 关闭 popup 不影响 content 继续翻译；重新打开会从 `page.status` 恢复进度/“还原”。

### 3. `popup.css`

- 主按钮：56×56，`border-radius: 50%`，居中，`font-size` 14–16；
- 模式切换：两个按钮，`aria-pressed="true"` 有选中样式；
- 语言下拉与 footer 紧凑排列；
- 不引入外部字体/图标。

---

## B5 验收 B

先补假 DOM，再写用例。`scripts/dom-smoke.mjs` 需要：

- `makeElement` 支持：`append`、`appendChild`、`remove`、`parentElement`、`parentNode`、`children`、`style`、`className`、`classList.contains/add/remove`、`setAttribute/getAttribute/hasAttribute`、`hidden`、`innerText` getter、`textContent` getter/setter、`closest('#id' | '.class' | 'tag')`、`querySelector` / `querySelectorAll`（至少支持 `.class` 和 tag）；
- `remove()` 必须从 `parent.children` 里删掉，并把 `isConnected` 递归置 false；
- `textContent` setter 要清空子节点再存文本；getter 要递归拼接；
- `innerText` getter 用 `\n` 连接块级子节点，叶子返回文本；
- `document.createElement` 返回的元素要有 `style` 对象；
- `globalThis.chrome.storage.local.get` stub 返回 `{ settings: { displayMode } }`，测试可切换；
- `globalThis.chrome.runtime.sendMessage` 继续返回 `{ ok, translations, protected, warnings: [] }`。

新增用例：

1. 纯译文：文本节点被替换，`<a>` 元素仍在、`textContent` 变译文（链接未失效）。
2. 双语 `p`：`span.sopen-translated-block` 出现在 `p` 内部末尾；`p` 的原文文本节点 `nodeValue` 不变（不是 `p.textContent`，因为追加译文后 `textContent` 会包含译文）。
3. 双语 `td`：`span` 在 `td` 内部；`tr.children.length` 不变（没有多出 `div`）。
4. 双语 `li`：`span` 在 `li` 内部；列表项数量不变。
5. 叶子 `div`：块文本 ≥ 40 字的 `div` 产生译文；包含 `p` 的 `div` 不产生。
6. 长块：>1200 字符的 `p` 被切成 2 段送翻，最终只插入一个 `span`，内容按顺序拼回。
7. 译文与原文相同 / 空译文：不插入 `span`。
8. 双语 → 还原：注入的 `span` 数量归零，原文完全复原。
9. 双轮：第二轮请求收到的原文里**不含**上一轮译文。
10. 模式互切：纯译文翻译 → 切双语翻译 → 还原，原文完全复原。
11. 翻译中拒绝还原（现有用例保留）。
12. 熔断：第一批成功，随后连续 3 批抛错 → `stopped === true`，第一批译文保留，后续不再请求。
13. 进度：翻译中 `page.status.progress` 的 `total > 0`，结束后 `done === total`。

命令：

```powershell
npm run check
npm run smoke:dom
```

---

# 阶段 C：术语保护

## C1 词库生成

### 1. 文件

| 文件 | 作用 |
| --- | --- |
| `scripts/glossary-allowlist.txt` | 人工维护；一行一个词；`#` 开头为注释；约 300–500 条 |
| `scripts/glossary-blocklist.txt` | 已知通用词/误伤词；命中即拒绝（大小写不敏感） |
| `scripts/glossary-snapshot.json` | 一次性从上游筛出的快照，入库；含 `generatedAt` / `sources` / `brands` / `models` |
| `scripts/build-glossary-snapshot.mjs` | **维护者手动跑**，联网抓取并筛选，写快照；不参与 `build:glossary` |
| `scripts/build-glossary.mjs` | 离线：allowlist + snapshot + blocklist → `extension/lib/glossary-data.json` |
| `extension/lib/glossary-data.json` | 构建产物，入库；运行时不联网 |

### 2. 快照筛选规则

- simple-icons：只保留“多词”或“含数字”的标题；单字母、纯小写单词、blocklist 命中一律丢弃。单字品牌（Docker、React、Vue 等）由 allowlist 负责。
- models.dev：只保留“多词”或“含数字”的模型名；`Search` / `Fast` / `Large` / `Auto` / `Echo` 这类纯单词丢弃。
- linguist：**不批量导入**；只用来核对 allowlist 里的语言名拼写。
- CNCF：只抽标题里的 ASCII 片段（`[A-Za-z][A-Za-z0-9.+-]*`，长度 ≥2），纯中文标题丢弃；保留多词/含数字的。
- 每类设上限（建议 brands 400 / models 400），最终与 allowlist 合并后仍受 800 硬上限约束；超了就构建失败，逼着继续人工筛。

### 3. `build-glossary.mjs`

- **不联网**；只读 allowlist + snapshot + blocklist。
- 归一化：trim、NBSP→空格、去空行、去注释。
- 校验：长度 2–60；拒绝换行、纯数字；拒绝 blocklist；去重（大小写不敏感，保留首次写法）。
- 排序：`localeCompare`。
- 输出：

```json
{
  "version": 1,
  "generatedAt": "2026-10-22",
  "count": 0,
  "terms": ["..."],
  "sources": [
    { "name": "simple-icons", "url": "...", "license": "CC0 1.0", "note": "extracted titles only" }
  ]
}
```

- `generatedAt` 取 snapshot 里的日期（不要用 `new Date()`），保证同一天跑两次字节一致；提供 `--check`：重新计算并比较 `terms` / `count` / `sources` / `version`（忽略 `generatedAt`），不一致就退出 1。
- `package.json` 加：

```json
"build:glossary": "node scripts/build-glossary.mjs",
"build:glossary:snapshot": "node scripts/build-glossary-snapshot.mjs"
```

### 4. allowlist 起步建议

先放这些类别，每条都人工确认“不会误伤普通英文”：

- 厂商/品牌：`DeepSeek`、`OpenAI`、`Anthropic`、`Cloudflare`、`GitHub`、`GitLab`、`Hugging Face`…
- 产品/协议：`Kubernetes`、`Docker`、`PostgreSQL`、`Redis`、`WebAssembly`、`OAuth`、`GraphQL`…
- 语言/框架（只放不会与普通词冲突的）：`JavaScript`、`TypeScript`、`Python`、`Kotlin`、`TensorFlow`、`PyTorch`…
- 型号全名：`DeepSeek V4.1 Flash`、`GPT-5`、`MiniMax M3.1`…

**不要**放：`X`、`Circle`、`Square`、`Meta`、`Go`、`Rust`、`Swift`、`C`、`R`、`Search`、`Fast`、`Large`、`Auto`、`Echo`、`bat`、`comma`、`smart`、`sharp`、`remark`。

---

## C2 `lib/glossary.js`

纯函数，不读 `chrome.*`、不联网：

```js
export function normalizeTerms(list) → string[]
export function compileGlossary(terms) → {
  terms,            // 规范化后的完整列表
  asciiRe,          // 单个 alternation，长词优先
  asciiCanonical,   // lower → 规范写法
  cjkTerms,         // 按长度降序
}
export function matchTerms(text, compiled) → { term, index }[]   // 含型号正则
export function promptTerms(matches, max = 40) → string[]
export function verifySegment({ source, translated, compiled, allowed }) → { ok, missing: string[] }
export function modelTokens(text) → string[]
```

匹配规则：

- ASCII：`(?<![A-Za-z0-9_.-])(?:term1|term2|…)(?![A-Za-z0-9_.-])`，`gi`；alternation 按长度降序，天然长词优先；
- CJK：`indexOf` 循环，长词优先；
- 合并 ASCII / CJK / 型号命中后，按 `index` 排序，重叠区间只保留更长的那个；
- 返回的 `term` 用规范写法（`asciiCanonical` 查表），大小写不敏感匹配；
- **型号正则**（内置规则，不属于词表）：
  - `/[A-Za-z][\w.]*\s?-?\s?v?\d+(?:\.\d+)+(?![\w.])/g`（覆盖 `V4.1`、`M3.1`）
  - `/\b[A-Z]{2,}[-\s]?\d+\b/g`（覆盖 `GPT-5`、`HTTP2`）
  - `V4`、`M3` 这种无小数点的短型号由 allowlist 里的全名覆盖（例如 `DeepSeek V4`、`MiniMax M3`），不要放宽到单字母+数字，否则 `A4`、`B5` 会误伤。
- `verifySegment`：只校验 `matchTerms(source)` 命中、且 `allowed` 允许的词；`allowed` 是本批 `termsForPrompt` 的小写集合，未注入 prompt 的词不校验。`translated` 做 `\s+ → ' '` 归一化后，ASCII 用 `toLowerCase().includes()`，CJK 用 `includes()`；缺任一 → `missing`。
- `promptTerms`：按 `index` 去重、截断 40；**校验也用这 40 条**，不要用完整词表。

性能：

- `compileGlossary` 只做一次；`providers.js` 用模块级单条缓存（key = terms.join('\u0000')）；
- 不要每段重新 `new RegExp`；
- 800 条以内的 alternation 在 20 段/批下足够快；如果实测慢，再按首字符分桶。

### 内置词库加载（在 `background.js`，不在 `glossary.js`）

```js
async function getGlossaryTerms(settings) {
  const user = normalizeTerms(settings.glossary.terms);
  if (!settings.glossary.useBuiltin) return user;
  const builtin = await loadBuiltinTerms();   // fetch(chrome.runtime.getURL('lib/glossary-data.json'))
  return normalizeTerms([...builtin, ...user]);
}
```

- `loadBuiltinTerms()` 失败（文件缺失、JSON 坏了）只 `console.warn`，返回 `[]`，翻译继续用用户词；不要阻断整页翻译。
- 不需要 `web_accessible_resources`：service worker 读的是自己包里的文件。
- 结果按 `useBuiltin + terms.join()` 做模块级缓存；`chrome.storage.onChanged` 里 `settings` 变化时清空。
- content script 永远不加载词库；词库只在 background 里。

---

## C3 prompt 注入 + 译后校验

- 注入在 `lib/prompt.js`；校验与修复在 `lib/providers.js` 的 `translateBatch()`（A4）。
- `buildSystemPrompt(target, terms)` 只带本批 `termsForPrompt`；`termsForPrompt` 为空时不追加任何术语段落。
- 校验只针对 `termsForPrompt`（见 A4 第 5 步）；被 40 条上限截掉的词不参与校验，避免“没告诉模型却要求它保留”。
- `segments` 允许 `null`；`parseSegments` 把 `null` 映射成 `''`。
- 校验顺序（单段）：
  1. `source` 无命中 → 不校验，直接采用；
  2. `translated` 为空 → 视为模型拒绝，`missing = 全部命中`；
  3. `verifySegment` 通过 → 采用；
  4. 不通过 → 按 `enforcement` 进入 fallback / repair / warn。
- `repair` 只重发失败段：
  - `subset = 失败段原文`；
  - `terms = 这些段缺失的词`；
  - `protocol.translate({ texts: subset, terms, repair: true, ... })`；
  - 第二次仍缺 → 回退原文；第二次长度不符 → 整批回退原文。
- `warn` 模式：
  - 保留译文；`warnings.push({ index, missing })`；
  - content 只在 toast 里显示“m 段可能未保留术语”，不逐段展开；
  - `console.debug` 输出 `{ index, missing }` 明细，方便调试。
- `protected` 与 `failed` 分开：`protected` 是术语层回退；`failed` 是请求/解析失败。两者都进最终提示，但文案不同。

响应契约：

```js
{ ok: true, translations: string[], protected: number, warnings: { index, missing }[] }
```

`translations.length === texts.length` 永远成立；`protected` 是计数，不是数组。

---

## C4 设置页（术语表）

- 开关：`#use-builtin` ↔ `settings.glossary.useBuiltin`。
- 文本域：一行一个词；保存时 `normalizeTerms`；空行忽略；大小写不敏感去重。
- 三档下拉 + 说明（文案见 A6）。
- 内置信息：条数、`generatedAt`、来源链接；如果 `glossary-data.json` 不存在，显示“先跑 `npm run build:glossary`”，不要让设置页崩。
- “关于与许可”折叠区：
  - 扩展版本（`chrome.runtime.getManifest().version`）；
  - simple-icons（CC0 1.0）；
  - CNCF Glossary（CC BY 4.0，署名 + “有改动：仅抽取术语标题/片段”）；
  - github/linguist（MIT，如果快照用到）；
  - models.dev（仅名称清单，注明来源与生成方式）；
  - 本项目仓库链接。

---

## C5 `THIRD-PARTY-NOTICES.md`（仓库根）

按快照实际用到的源写，每条包含：

- 来源 URL；
- 许可证全名与链接；
- 用途（例如“品牌名候选，仅提取 title”）；
- 是否修改（例如“仅抽取 title 并过滤通用词”）；
- CC BY 4.0 的 CNCF 条目必须写等价声明：

```
© Cloud Native Computing Foundation, licensed under CC BY 4.0.
Modified: extracted ASCII term fragments from zh-cn glossary titles only.
```

如果最终快照没有用某个源，不要为了“齐全”硬写；notices 只列实际产物里的来源。

---

## C6 验收 C

- `npm run check` / `npm run smoke` / `npm run smoke:dom` 全绿。
- `npm run build:glossary` 后跑 `npm run build:glossary -- --check`，退出码 0；文件已入库时再跑 `git diff --exit-code extension/lib/glossary-data.json` 确认无变化。
- 新增冒烟用例（A7 已列）覆盖：术语注入、fallback、repair 子集、warn、DeepL 跳过、型号正则、40 条上限、迁移幂等。
- 真机四页，两种模式各跑一次 + 还原：
  - `https://opencode.ai/go`
  - `https://github.com/anomalyco/opencode/issues/55772`（等 React 渲染完再点）
  - `https://www.linux.org/pages/download/`
  - `https://en.wikipedia.org/wiki/Linux`
- 真机严格按开头「测试范围（硬约束）」选模型：商汤 `sensenova-6.8-flash-lite`；OpenCode Go 只用 `deepseek-v4.1-flash`、`mimo-v2.6-flash`、`minimax-m3.1-flash-free`。DeepL 可作对照——它一定会把专有名词翻掉，正好用来展示差距。
- 手工检查清单：
  1. `DeepSeek V4.1 Flash` 在两种模式下都原样保留；
  2. 双语模式下 `td` / `li` / `p` 的 DOM 结构没有被破坏（表格列数、列表项数不变）；
  3. 双语还原后 `span.sopen-translated-block` 数量为 0；
  4. 纯译文 → 双语 → 还原，原文完全复原；
  5. 术语三档各切一次，toast 文案与行为一致；
  6. 模型下拉刷新能拿到 OpenCode Go 的 36 个模型；断网/错 key 时退回预设且不弹红字；
  7. 语言下拉在 popup 与设置页回显一致；
  8. 设置页保存后重新打开，`enforcement` / `useBuiltin` / 用户词表 / 语言都还在。

---

# 阶段 D：收尾

## D1 版本与文档

- `extension/manifest.json` 版本 `0.2.0`。
- `README.md`：
  - 服务表改成 12 预设 + 自定义；
  - 增加“双语模式”“术语保护”“三档策略”“语言列表”；
  - 测试命令增加 `npm run build:glossary`；
  - “未实现”里删掉“原文/译文对照”，保留翻译缓存、快捷键、按站点开关等；
  - “已知限制”补：双语模式跳过含代码的块；DeepL 不支持术语保护；SPA 页面需等渲染；长块按句切分会丢一点上下文。
- `AGENTS.md`：
  - “测试只有一个 provider 冒烟脚本”改成三条命令 + `build:glossary`；
  - 补不变量：`content.css` 的 `.sopen-translated-block` 是唯一作用域例外；`glossary-data.json` 是构建产物；`models.list` 不落草稿；测试不 import `background.js`；
  - 补“content.js 不能 import”仍然有效。
- `package.json`：只加 scripts，不加依赖。
- `THIRD-PARTY-NOTICES.md` 入库。

---

# 施工约束（给执行者）

- 不加大依赖；`package.json` 最多增加 `scripts` 条目。
- 全程 `checkJs` 零错误；`content.js` 里出现 `import` 即为返工。
- 不改 `host_permissions`、不改 `all_frames: false`、不引入构建产物（`glossary-data.json` 是数据产物，不是打包产物）。
- `content.css` 的作用域例外只允许 `.sopen-translated-block` 一条；不要顺手把 toast 样式放出去。
- 每个阶段结束都跑一次对应验收，别把三阶段的改动堆到最后一起调。
- 术语层出问题时先关掉 `useBuiltin` 复现，再判断是渲染、prompt 还是校验。
- `models.list` 的缓存写入必须走 `patchProvider`，不要用设置页 draft 覆盖已保存配置。
- 任何测试/示例/文档不得出现真实 key；OpenCode Go 的 session 是随机 UUID，不是密钥，但也不要写进仓库。
- 调试 OpenCode Go 时先确认 `x-opencode-session` 有值；漏发就是全网 400，这是最容易踩的一脚。

---

# 已知风险

- **OpenCode Go 流量风控**：官方文档写明面向 coding agent 流量，整页翻译可能被判异常（429/封 key）。另外 Go 强制要求 `x-opencode-session`，漏发就是全网 400。
- **OpenCode Go 的 models 地址**：`{baseUrl}/models` 是 404，必须用预设里的 `modelsUrl`；改 baseUrl 时记得同步失效缓存。
- **`User-Agent` 不可靠**：浏览器 fetch 可能丢弃；不要把 OpenCode Go 的成功建立在 UA 上。如果后续确认必须校验，再评估 `declarativeNetRequest`（本轮不做）。
- **商汤限流很低**：实测一次并发请求即 `429 tpm/rpm limit`，串行 + 退避重试是硬需求；连续 3 批失败会熔断，长页面可能只翻一部分。
- **提示词不是硬约束**：`fallback` / `repair` 只拦“术语消失”，拦不住“译成中文又保留英文”的半对情况；`warn` 模式更是只提示。
- **词表误伤/漏词**：精选 allowlist 降低了 `X`/`Circle`/`Search` 这类误伤，但仍可能漏掉新品牌；用户词表是兜底。型号正则只覆盖“字母+小数点数字”和“大写缩写+数字”，`V4`/`M3` 依赖 allowlist。
- **校验是精确匹配**：模型把 `DeepSeek V4.1 Flash` 写成 `DeepSeek V4.1  Flash`（多空格）已在 `verifySegment` 里归一化；但换成全角空格、换行、插入零宽字符仍会误判。
- **双语 DOM**：含内联 `<code>` 的段落会被整块跳过；SPA 重渲染会丢掉注入的 `span`；宿主页 CSS 可能覆盖译文块样式；`innerText` 在超长页面上可能卡顿。
- **长块切分**：按句切会丢跨句上下文；单句超 1200 字符时硬切，可能切断词。
- **12 个预设里 9 个未实测**：baseUrl / 模型名可能过期；设置页必须显示“接口未实测”，验收不要用它们跑真机。
- **`response_format` 回退收窄**：这是对现有行为的有意修改；400/404/422 之外的 4xx 不再重发，避免 401/429 双发。
- **设置页与后台的存储竞争**：`mergeProviderCaches` 只解决模型缓存被旧 draft 覆盖；两个设置页同时打开仍是“最后保存者赢”。
- **翻译中改目标语言**：background 每批读一次 settings；popup 在 busy 时已禁用语言/模式，但设置页不感知正在翻译，仍可能让同一页前后批次用不同目标语言。已知限制，不额外加锁。
- **语言列表收窄**：统一 10 项后，老用户的自定义目标语言只能保留为只读“当前：X”，不能继续新增；这是有意的范围收缩。
- **DeepL 无术语保护**：这是能力边界，不是 bug；设置页要写明。

---

# 不做的事

- 划词翻译、右键翻译、流式输出、翻译缓存、自动学习术语。
- 自定义请求头 / 附加请求体 JSON。
- 双语模式保留原文内联结构（链接在译文块里不可点，原文块仍可点）。
- 术语 → 指定译法（只做 DNT）。
- 按 provider 单独设置术语策略（全局一档）。
- Anthropic / Gemini / Responses 的内置预设（协议保留，自定义可用）。
- 双语/纯译文切换后自动重翻（只提示用户还原后重翻）。
- 为 provider 写各自的重复请求实现——一律走协议层。
- 为 `models.list` 做后台定时刷新或跨设备同步。
- Firefox 兼容、打包工具、运行时依赖。
