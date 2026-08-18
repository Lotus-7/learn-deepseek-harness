# Learn DeepSeek Harness

从最小循环到生产级 agent harness 的学习课程：概念演进 + 可运行示例 +
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 真实源码导读。

在线阅读：GitHub Pages（见 About）；课程时间线从 [s01 最小循环](lessons/s01-min-loop/README.md) 开始。

## 快速开始

需要 Node >= 22 与 pnpm。

```sh
pnpm install
pnpm --filter @learn-dsh/s01-min-loop dev   # 跑任意一课，无需 API key
pnpm test                                    # 全部课程的 smoke 测试
pnpm site:dev                                # 本地起站点
```

## 仓库结构

```
lessons/    每课一个自包含包：README.md（文稿）+ lesson.yaml（元数据）+ src/
  shared/   课程共享的 mock 模型适配器
scripts/    sync-lessons：统计元数据 + 投影站点页面
site/       VitePress 站点（lessons 页面由脚本生成，不入库）
```

## 写作约定

- 新增一课：`lessons/<sXX-slug>/` 按 s01 模式建包与文稿，然后 `pnpm run sync`，
  再在 `site/.vitepress/config.ts` 的 sidebar 加一行。
- 每课工具必须用 `defineTool` 定义（统计口径）；行数/工具数由脚本写回，
  CI 用 `git diff --exit-code` 防手抄漂移。
- dsh 源码链接在 lesson.yaml 的 `verifiedDshVersion` 锚定验证版本。
