# Learn DeepSeek Harness

[![CI](https://github.com/Lotus-7/learn-deepseek-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/Lotus-7/learn-deepseek-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

从最小循环到生产级 agent harness 的学习课程：概念演进 + 可运行示例 +
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 真实源码导读。

在线阅读：https://lotus-7.github.io/learn-deepseek-harness/ ；课程时间线从 [s01 最小循环](lessons/s01-min-loop/README.md) 开始。

## 快速开始

需要 Node >= 22 与 pnpm。

```sh
pnpm install
pnpm --filter @learn-dsh/s01-min-loop dev   # 跑任意一课，无需 API key
pnpm test                                    # 全部单元与集成测试
pnpm run smoke:lessons                       # 逐课执行 README 承诺的 dev 入口
pnpm run validate                            # 检查 16 课的文稿/元数据/入口契约
pnpm run check                               # 完整本地验收
pnpm site:dev                                # 本地起站点
```

## 课程总览（16 课 · 五个阶段）

每课一个自包含包，README 即文稿，**为什么 → 跑起来 → 看真码** 三段式；
示例全部离线可跑（剧本回放，无需 API key）。

| 课 | 主题 | 核心理念 |
|---|---|---|
| **阶段一 · 最小循环** | | |
| [s01](lessons/s01-min-loop/README.md) | 最小循环 | 调模型、跑工具、喂结果的最小循环 |
| [s02](lessons/s02-tools/README.md) | 工具与管线 | 校验 → 守卫 → 执行 → 留痕，失败也回喂模型 |
| [s03](lessons/s03-session-log/README.md) | 会话日志 | append-only 事件流；历史是投影，不是状态 |
| **阶段二 · 可控与可恢复** | | |
| [s04](lessons/s04-permission/README.md) | 权限与审批 | 三态守卫 + 审批回调 + fail-safe 默认 |
| [s05](lessons/s05-recovery/README.md) | 取消与恢复 | AbortSignal 贯穿调用链；错误分层收口 |
| [s06](lessons/s06-compaction/README.md) | 上下文压缩 | 注入式摘要替代头部；日志依旧只增不改 |
| **阶段三 · 插件化** | | |
| [s07](lessons/s07-cordis/README.md) | 迷你 Cordis | ctx、可逆 effect、typed events、瀑布拦截链 |
| [s08](lessons/s08-plugins/README.md) | 五件套插件化 | s01–s06 成果拆成可单独替换、单独拆掉的插件 |
| [s09](lessons/s09-seam/README.md) | 能力接缝 | Definition / Provider / Consumer 三角色 |
| **阶段四 · 生产化能力** | | |
| [s10](lessons/s10-sandbox/README.md) | 沙箱执行世界 | 本地与沙箱一键互换，工具一个字不用改 |
| [s11](lessons/s11-subagent/README.md) | 子代理 | 委派、上下文隔离与深度上限 |
| [s12](lessons/s12-skills/README.md) | 技能与工作流 | 规程注入 system 段；start/collect 异步取回 |
| [s13](lessons/s13-persistence/README.md) | 持久化 | JSONL 落盘——恢复、分叉、回放三项免费 |
| **阶段五 · 组装与桥接** | | |
| [s14](lessons/s14-bundles/README.md) | profile 组装 | base / profile / patch：装配数据化 |
| [s15](lessons/s15-bridge/README.md) | 桥接真包 | 用真实 @deepseek-ai/dsh-* 包重装同一套概念 |
| [s16](lessons/s16-recap/README.md) | 全景回顾 | 扩展点地图逐行对上你写过的代码 |

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
- 每课必须保留 `README.md`、`lesson.yaml`、`src/index.ts`、至少一个测试文件和
  `tsx src/index.ts` 公开入口；`pnpm run validate` 会统一检查。
- dsh 源码链接在 lesson.yaml 的 `verifiedDshVersion` 锚定验证版本。
