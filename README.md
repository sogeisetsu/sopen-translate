# sopen-translate

一个轻量的浏览器翻译插件：整页翻译，翻译能力由你自己配置的 API 密钥驱动，可接入多种翻译服务。

## 目标

- 整页翻译，尽量不破坏原页面结构，随时可还原
- 多后端可切换（OpenAI 兼容接口、DeepL，可扩展）
- API 密钥保存在浏览器本地，不上传、不同步、不进仓库
- 设置页可管理多个密钥配置、测试连通性、设定默认服务

## 设计约束

- Manifest V3，只针对 Chrome / Edge，不做 Firefox 兼容
- 无后端、无构建步骤：源码目录就是可加载的扩展，纯 ES module + 原生 DOM
- 无运行时依赖，不装 npm 包
- 密钥只存 `chrome.storage.local`，只有 service worker 读取，content script 拿不到
- 出网只发生在 service worker 里，content script 只负责 DOM

## 目录

```
extension/              # chrome://extensions 里直接加载这个目录
  manifest.json
  background.js         # service worker：消息路由 + 唯一的出网口
  content.js            # 整页翻译、还原、进度提示（无 import，classic script）
  content.css           # 全部样式限定在 #sopen-translate-ui 下
  popup.html/js/css     # 工具栏弹窗：翻译此页 / 还原 / 打开设置
  options.html/js/css   # 设置页：服务管理、密钥、目标语言、连通性测试
  lib/
    settings.js         # chrome.storage.local 读写 + 默认值
    providers.js        # 翻译服务适配层（类型、字段、translate 实现）
```

## 安装

1. 打开 `chrome://extensions`，开启「开发者模式」
2. 「加载已解压的扩展程序」，选 `extension/` 目录
3. 首次安装会自动打开设置页，添加一个翻译服务并填入密钥
4. 点工具栏图标 → 「翻译此页」；翻完可以点「还原」退回原文

## 已支持的翻译服务

| 类型 | 说明 | 需要的字段 |
| --- | --- | --- |
| OpenAI 兼容接口 | OpenAI / DeepSeek / Moonshot / One-API / Ollama 等任何提供 `/chat/completions` 的服务 | 接口地址、模型、API Key |
| DeepL | 免费版用 `https://api-free.deepl.com`，付费版用 `https://api.deepl.com` | 接口地址、API Key |

### 加一个新服务

改 `extension/lib/providers.js`，往 `PROVIDER_TYPES` 里加一个对象：

```js
{
  type: 'my-service',
  label: '显示名',
  hint: '设置页说明',
  fields: [{ key: 'apiKey', label: 'API Key', secret: true, required: true }],
  async translate({ texts, config, target, targetCode, signal }) {
    // 必须按输入顺序返回同样数量的字符串
    return texts;
  },
}
```

设置页和后台会自动认这个新类型。`translate` 里返回数量对不上会直接报错——宁可失败，也不能把译文错位写回页面。

## 现状与边界

- 已实现：整页翻译（按字符预算分批）、还原原文、多服务管理、连通性测试
- 未实现：翻译缓存、原文/译文对照、快捷键、按站点开关、接口用量统计
- 已知限制：只在顶层 frame 生效；不分段保留页面内联标签的结构；超长页面会串行发多批请求

## 状态

MVP 骨架，尚未在真机上接真实密钥跑过完整回归。
