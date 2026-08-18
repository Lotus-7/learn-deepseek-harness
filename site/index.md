---
layout: home
hero:
  name: Learn DeepSeek Harness
  text: 从最小循环到生产级 agent harness
  tagline: 概念演进 + 可运行示例 + deepseek-harness 真实源码导读。不需要 API key，每课克隆即可跑。
  actions:
    - theme: brand
      text: 从 s01 开始
      link: /lessons/s01-min-loop/
    - theme: alt
      text: 看时间线
      link: /timeline
    - theme: alt
      text: GitHub
      link: https://github.com/Lotus-7/learn-deepseek-harness
features:
  - icon: 🔁
    title: 阶段一 · 最小循环
    details: 循环、工具、会话日志——harness 的三块地基，纯手写零框架。
  - icon: 🛡
    title: 阶段二 · 可控与可恢复
    details: 权限审批、取消与错误恢复、上下文压缩。
  - icon: 🧩
    title: 阶段三 · 插件化
    details: ctx、可逆 effect、capability seam——dsh「一切皆插件」的机制。
  - icon: 🏭
    title: 阶段四 · 生产化能力
    details: 沙箱与统一执行世界、子代理、技能、持久化。
  - icon: 🚀
    title: 阶段五 · 组装与桥接
    details: profile/bundle 组装，用真实 dsh 包搭你自己的 harness。
---

## 快速开始

```sh
git clone https://github.com/Lotus-7/learn-deepseek-harness.git
cd learn-deepseek-harness
pnpm install
pnpm --filter @learn-dsh/s01-min-loop dev
```

无需 `DEEPSEEK_API_KEY`：所有课程默认使用剧本回放的 mock 模型。
