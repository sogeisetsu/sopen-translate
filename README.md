# sopen-translate

一个轻量的浏览器翻译插件：整页翻译，翻译能力由你自己配置的 API 密钥驱动，可接入多种翻译服务。

- 纯译文 / 双语两种展示模式，随时可还原
- 视口优先：先翻当前视野，滚动继续补翻；也可切「整页」一次翻完
- 术语保护：品牌、产品、型号名不被翻译（可内置词库 + 自定义词表）
- 12 个内置服务预设 + 自定义，模型列表可联网刷新
- API 密钥保存在浏览器本地，不上传、不同步、不进仓库

## 设计约束

- Manifest V3，只针对 Chrome / Edge，不做 Firefox 兼容
- 无后端、无打包步骤：源码目录就是可加载的扩展，纯 ES module + 原生 DOM
- 无运行时依赖；npm 只用来跑类型检查与冒烟测试，不参与扩展加载
- 密钥只存 `chrome.storage.local`，只有 service worker 读取，content script 拿不到
- 出网只发生在 service worker 里，content script 只负责 DOM

## 目录

```
extension/              # chrome://extensions 里直接加载这个目录
  manifest.json
  background.js         # service worker：消息路由 + 唯一的出网口
  content.js            # 视口优先/整页翻译、双语渲染、滚动续翻、还原、进度（无 import，classic script）
  content.css           # 浮层样式；.sopen-translated-block 是唯一的作用域例外
  popup.html/js/css     # 工具栏弹窗：翻译/还原、模式、语言、进度
  options.html/js/css   # 设置页：服务预设、模型、术语表、语言、关于
  lib/
    settings.js         # chrome.storage.local 读写、schema 迁移、sessionId
    languages.js        # 目标语言唯一来源（10 项）
    provider-presets.js # 12 个内置预设 + custom
    protocols.js        # 5 种协议的 URL / 鉴权 / 请求体 / 响应解析
    providers.js        # translateBatch：等长校验 + 术语注入 + 译后校验
    http.js             # 超时、429 退避、ProviderError
    segments.js         # 模型返回解析
    prompt.js           # 各协议共用的 system / repair prompt
    models.js           # 模型列表 URL 推导、解析与回退
    glossary.js         # 术语匹配与校验（纯函数）
    glossary-data.json  # 内置词库（构建产物，由 build:glossary 生成）
scripts/
  smoke.mjs             # provider / 协议 / 术语 / 迁移冒烟
  dom-smoke.mjs         # content script 状态机冒烟（假 DOM）
  build-glossary.mjs    # 离线生成内置词库
  build-glossary-snapshot.mjs  # 维护者手动刷新上游快照（联网）
  glossary-allowlist.txt / glossary-blocklist.txt / glossary-snapshot.json
```

仓库根另有 `tsconfig.json`、`types.d.ts`（只给 `checkJs` 静态检查用）和 `THIRD-PARTY-NOTICES.md`。

```
npm install                   # 只为类型检查装 typescript + @types/chrome
npm run check                 # tsc --noEmit，改完应当零错误
npm run smoke                 # provider 契约冒烟：stub fetch，不联网、不需要密钥
npm run smoke:dom             # content script 状态机：假 DOM + 双语/还原/熔断
npm run build:glossary        # 离线生成 extension/lib/glossary-data.json
npm run build:glossary -- --check   # 校验入库词库与源文件一致
```

## 安装

1. 打开 `chrome://extensions`，开启「开发者模式」
2. 「加载已解压的扩展程序」，选 `extension/` 目录
3. 首次安装会自动打开设置页，选一个预设、填密钥，保存
4. 点工具栏图标 → 圆形主按钮「翻译」；翻完点「还原」退回原文

## 翻译服务

内置 12 个预设，另可添加「自定义」（5 种协议任选）。**标「接口未实测」的只有路由级验证，没有真 key 端到端跑过**，设置页会明确标注。

| 预设 | 协议 | 验证状态 |
| --- | --- | --- |
| OpenCode Go | OpenAI Chat | 已实测（需要 `x-opencode-session`，扩展自动带上） |
| 商汤 SenseNova | OpenAI Chat | 已实测（RPM 较低，自动退避重试） |
| DeepL | DeepL | 已实测（不支持术语保护） |
| OpenAI | OpenAI Chat | 接口未实测 |
| DeepSeek | OpenAI Chat | 接口未实测 |
| Kimi（中国站 / 国际站） | OpenAI Chat | 接口未实测 |
| 智谱 GLM | OpenAI Chat | 接口未实测 |
| 阿里百炼 | OpenAI Chat | 接口未实测 |
| MiniMax | OpenAI Chat | 接口未实测 |
| OpenRouter | OpenAI Chat | 接口未实测 |
| 硅基流动 | OpenAI Chat | 接口未实测 |
| 自定义 | 5 种协议任选 | 取决于你填的地址 |

- **模型**：下拉 + 「刷新」按钮；刷新会调后台 `models.list`，失败/超时就退回预设建议，不弹红字。也可以切「手动输入」。
- **自定义协议**：`openai-chat`、`openai-responses`、`anthropic-messages`、`google-gemini`、`deepl`。
- **本地服务**（Ollama / One-API）走「自定义」，API Key 可以留空。

### 加一个新服务

改 `extension/lib/provider-presets.js`，往 `PROVIDER_PRESETS` 加一条预设；`{baseUrl}/models` 不是通用推导时补 `modelsUrl`（OpenCode Go 就是反例）。新协议才需要动 `extension/lib/protocols.js` 与 `types.d.ts`。

## 双语模式

- popup 里切换「纯译文 / 双语」，立即保存；已翻译的页面需要点「还原」后重新翻译生效。
- 双语把译文追加到块元素内部末尾（`span` + `display:block`），不新增兄弟 `div`，表格列数与列表项数不变。
- 只按 `p/li/h*/td/th/...` 收集块；纯 div 页面会把「没有块级后代且文本 ≥40 字」的 `div/section/article/main` 当块。
- 超过 1200 字符的块按句切开分别送翻，再拼回一个译文块。
- 含代码（`pre/code/kbd/...`）的块整块跳过，避免把代码翻坏。

## 翻译范围

- **视口优先（默认）**：点翻译后只翻当前视口 + 上下 500px 余量，首屏先出译文；滚动、窗口尺寸变化、SPA 新插入内容时继续补翻。
- 视口首屏和续翻会把批次再切小（≤2000 字符 / 60 段），让第一批译文尽快出现；整页模式仍按 provider 策略分批。
- **整页**：一次性翻完整个页面，行为与旧版一致，适合对照或需要全文时使用。
- popup 里切换范围；已翻译的页面需要「还原」后重新翻译生效。
- 滚动补翻只处理新进入视口的候选；成功处理过的节点/块不会重复送翻，失败项会在下次滚动时重试。标签页隐藏时暂停，回到前台补扫一次。
- 进度只统计已经送翻的段：初次是视口内的段数，后续发现新内容时 `total` 累加，不要当成整页百分比看。

## 术语保护

目标是让 `DeepSeek V4.1 Flash` 不会被译成「深度求索 4.1 闪电版」。

- **内置词库**：797 条，来自人工 allowlist + 上游筛选快照（simple-icons、models.dev），构建时离线生成；设置页可开关。
- **自定义词表**：一行一个词，只做「保持原文」（不做术语 → 指定译法）。
- **型号规则**：`GPT-5`、`V4.1`、`M3.1` 这类“字母 + 版本号”自动保护；`V4`/`M3` 这种短型号靠词表里的全名。
- **三档策略**（设置页写清了后果）：
  - `fallback`：漏词就整段保留原文。最保守，可能出现成片未翻译。
  - `repair`：先只重翻漏词段，仍漏才保留原文。默认。
  - `warn`：译文照常显示，只在结果里提示可能漏词。最流畅。
- **DeepL 不支持术语保护**：它没有 prompt 通道，扩展对它完全跳过术语层。
- 每批最多把 40 条命中术语注入 prompt，校验也只针对这 40 条。

## 目标语言

popup 与设置页共用 `extension/lib/languages.js` 的 10 项列表：简体中文、繁体中文、日语、韩语、英语、法语、德语、西班牙语、俄语、葡萄牙语。老用户列表外的值会保留为只读的「当前：X（不在列表）」。

## 现状与边界

- 已实现：视口优先 + 滚动续翻（可切整页）、整页翻译（按 provider 策略分批、最多 8 路并发、失败批自动补跑、按 provider/模型关闭思考）、纯译文与双语、还原、多服务与预设、模型列表刷新、术语保护三档、进度轮询、连通性测试
- 未实现：划词翻译、翻译缓存、快捷键、按站点开关、接口用量统计、术语 → 指定译法
- 已知限制：
  - 只在顶层 frame 生效；不分段保留页面内联标签的结构
  - 双语模式跳过含代码的块；SPA 页面需要等渲染完成再点翻译（之后新插入的内容会由视口续翻补上）
  - 长块按句切分会丢一点跨句上下文；单句超 1200 字符时硬切
  - 无限滚动页面会持续产生补翻任务，靠熔断与隐藏暂停兜底；进度 `total` 会随滚动增长
  - 翻译中改目标语言：popup 会禁用相关控件，但设置页不感知，可能让同一页前后批次用不同语言
  - 12 个预设里有 9 个只有路由级验证，baseUrl / 模型名可能过期
  - 限流端点（OpenCode Go、商汤）在超长页面上可能因 429 触发熔断，只翻一部分；长页面优先用 DeepL
- 行为说明：每一轮翻译都从原文出发，开始时会先撤销上一轮的译文。如果新一轮第一批就失败（例如密钥失效），页面会停在原文；其余批次失败会继续，**连续 3 批失败则熔断**，保留已翻部分。

## 状态

`0.2.0`。自动化检查（类型、两套冒烟、词库一致性）通过；四个验收页的真机回归尚未跑。
