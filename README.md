# GitHub 每日情报

自动生成的 GitHub 中文日报，运行在 GitHub Actions 云端。第一阶段已实现：

- 今日全站热门 Top 10；
- 今日中文热门 Top 10；
- GitHub Trending 的当日热度信号 + GitHub API 的真实 Star、Fork、语言、创建时间；
- 中文项目的 README/简介有效中文文本校验；
- 每日 JSON 历史和静态日报页面；
- 北京时间每天 08:17（UTC 00:17）自动运行，也可在 Actions 中手动运行。

## 一次性设置

1. 在仓库 **Settings → Secrets and variables → Actions** 中新增 Secret：
   - 名称：`GH_TOKEN`
   - 值：仅具备读取公开 GitHub API 权限的 Fine-grained Token。
2. 在仓库 **Settings → Pages** 中把 Source 设为 **GitHub Actions**。
3. 打开 **Actions → Generate daily GitHub report → Run workflow**，手动运行第一份日报。

Secret 只会注入到 GitHub Actions 运行环境；不会写进代码、日报 JSON、HTML、日志或提交。

## 数据与失败策略

- 排名仅由 GitHub Trending 的“stars today”信号排序；AI 不参与抓数或排序。
- 中文榜从 GitHub Trending 中文候选出发，要求 README/简介有至少 40 个中文字符且中文有效字符占比不低于 12%。
- 每个来源最多重试 3 次。单一来源失败时，页面显示失败提示并沿用上次成功数据；两个来源都失败且没有历史成功日报时，工作流失败且不写入空日报。
- 第一阶段不调用 DeepSeek；24h 增长、AI 榜、新项目榜和自定义关键词榜将在后续阶段加入。

## 输出

- `docs/index.html`：GitHub Pages 首页；
- `docs/history/YYYY-MM-DD.json`：按日保存的报告；
- `data/latest.json`：最新原始报告；
- `data/history/index.json`：历史索引。
