# 第三方数据来源与许可

`extension/lib/glossary-data.json` 是内置术语词库，由 `npm run build:glossary` 从
`scripts/glossary-allowlist.txt`、`scripts/glossary-snapshot.json`、
`scripts/glossary-blocklist.txt` 离线生成。运行时不联网。

下面只列**当前产物实际用到**的来源。

## simple-icons

- 来源：https://github.com/simple-icons/simple-icons
- 数据：https://unpkg.com/simple-icons@latest/data/simple-icons.json
- 许可证：CC0 1.0 Universal（https://creativecommons.org/publicdomain/zero/1.0/）
- 用途：品牌名候选。
- 修改：仅提取条目的 `title`；只保留多词或含数字的标题，并按
  `scripts/glossary-blocklist.txt` 过滤通用词，最终截断到固定条数。

## models.dev

- 来源：https://models.dev
- 数据：https://models.dev/api.json
- 许可证：来源站点未标注许可证；本项目仅使用其中的**模型名称**（事实性清单），
  不复制其描述、代码或其它内容。
- 用途：模型名候选（例如 `DeepSeek V4.1 Flash`）。
- 修改：仅提取模型 id / 名称；只保留多词或含数字的名称，过滤通用词并截断到固定条数。

## 说明

- 词库中的名称归各自权利人所有，这里仅用于“翻译时保持原文”，不表示任何商标授权或背书。
- 本项目自身代码的许可见仓库根目录。
