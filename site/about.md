# 关于

本站通过「概念演进 + 可运行最小示例 + 真实源码导读」三段式，
拆解 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
（dsh）——一个构建在 vendored Cordis 上、一切皆插件的生产级 agent harness。

与 [Learn Claude Code](https://learn.shareai.run/zh/timeline/) 的区别：
那边的教学对象源码不可读，只能从零重建；dsh 是开源生产代码库，本站
每课都直接导读真实包，示例是通往真码的桥。

## 适合谁 / 怎么学

- **前置**：会写 TypeScript（见到泛型与 `async/await` 不陌生即可），不需要任何框架经验；
  装好 Node ≥ 22 与 pnpm。想看懂「为什么」与术语对照，代码细节可以按需跳读。
- **顺序**：按 s01 → s16 读。每课三段——「为什么」讲问题与设计，「跑起来」逐文件走读
  可运行示例，「看真码」导读 dsh 对应包。s02–s14 是复制前进：每课在前一课代码上叠一层，
  跳读中间课后仍能接上。
- **节奏**：一课约 30–60 分钟（读文稿 + 跑示例 + 「改两个地方感受一下」）；全部离线可跑，
  不需要 `DEEPSEEK_API_KEY`。
- **卡住了**：先跑 `pnpm run check` 确认环境（测试、逐课 smoke、站点构建一次过）；
  仍有问题去 [GitHub Issues](https://github.com/Lotus-7/learn-deepseek-harness/issues) 提问。

## 怎么跑课程

```sh
pnpm install
pnpm --filter @learn-dsh/s01-min-loop dev   # 任意一课，无需 API key
pnpm test                                    # 全部单元与集成测试
pnpm run smoke:lessons                       # 逐课验证公开 dev 入口
```

## 版本锚定

dsh 处于 pre-release，会自由重命名与重排包。每课 `lesson.yaml` 的
`verifiedDshVersion` 标注导读链接验证过的版本；当前为 `0.1.0-rc.5`。
跟随升级是显式动作：改锚点、重走导读、更新文稿。

## 课程怎么长出来

写作即学习：每课按「读 dsh 对应包 → 写最小示例 → 写文稿 → 构建验证」
推进。s01 是本站第一课；s02–s16 已按首页五个阶段全部上线。

## 本站仓库

在线阅读：https://lotus-7.github.io/learn-deepseek-harness/
仓库：[learn-deepseek-harness](https://github.com/Lotus-7/learn-deepseek-harness)。
课程文稿与代码同目录（`lessons/<课>/`），站点页面由 `pnpm run sync`
从文稿投影生成，不重复维护。
