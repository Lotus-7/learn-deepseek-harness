# learn-deepseek-harness 学习网站设计

日期：2026-08-17
状态：已与小七大人逐节确认

## 背景与目标

两个目标，一体两面：

1. **理解 deepseek-harness（dsh）的实现逻辑**，为未来结合自己的业务做二次开发打基础。dsh 的二次开发要点是「一切皆插件」：改业务基本不动核心循环，而是在 seam 与扩展点上挂插件（见 dsh 仓库 `docs/architecture.md` 的 "Where new behavior goes" 表）。
2. **打造一个学习网站**（形态参考 shareAI-lab 的 Learn Claude Code，https://learn.shareai.run/zh/timeline/ ），帮助自己理解并帮助他人学习。

参考站调研结论：Learn Claude Code 采用「从零重建」教学模型（s01–s20，从 102 行最小循环渐进到 1708 行完整系统），因为它教的 Claude Code 源码不可读。dsh 是开源生产代码库且自带高质量文档，因此本站采用不同的模式。

写作过程即学习过程（以教代学）：每课的工作环是学习路径本身。

## 已确认的决策

| 决策点 | 选择 |
|---|---|
| 内容模式 | 混合式：概念演进 + 可运行最小示例 + dsh 源码导读 |
| 读者定位 | 入门开发者主线 + 每课「进阶造读」段落服务有 agent 经验者 |
| 示例形态 | 每课一个独立可跑的小项目，共享 mock 模型适配器，无 API key 全部可跑 |
| 内容语言 | 先纯中文，专业术语保留英文对照；后续有需要再加英文版 |
| 项目位置 | 独立新仓库（本仓库），不 fork dsh、不混入上游 |
| 技术栈 | VitePress + pnpm workspace monorepo（与 dsh 上游文档站同栈） |

## 课程大纲（5 阶段 16 课）

每课「核心理念 → dsh 映射」。课程线即学习路径：

### 阶段一 · 最小循环（纯手写，零框架）

| 课 | 代号 | 核心理念 | dsh 映射 |
|---|---|---|---|
| s01 | min-loop | 最小可用的 agent = 调模型、跑工具、喂结果的循环 | `packages/core/agent-loop` |
| s02 | tools | 工具 = schema + 注册表 + 守卫执行管线 | `packages/core/tools` |
| s03 | session-log | append-only 事件日志是模型的记忆与真理之源 | `packages/core/session` |

### 阶段二 · 可控与可恢复

| 课 | 代号 | 核心理念 | dsh 映射 |
|---|---|---|---|
| s04 | permission | 权限与审批：工具不是想跑就能跑 | `packages/interaction` |
| s05 | recovery | 取消、错误恢复、turn 生命周期 | `packages/core/agent` |
| s06 | compaction | 上下文压缩：在有限窗口里干无限的活 | `packages/compaction` |

### 阶段三 · 插件化（Cordis 之道）

| 课 | 代号 | 核心理念 | dsh 映射 |
|---|---|---|---|
| s07 | cordis | ctx、可逆 effect、typed events：一切皆插件 | `docs/cordis-primer.md` |
| s08 | plugins | 把 s01–s06 的成果拆成插件：核心五件套如何协作 | `packages/core/*` |
| s09 | seam | capability seam 三角色：换个 provider，整个世界跟着走 | `packages/fs`、`packages/shell` |

### 阶段四 · 生产化能力

| 课 | 代号 | 核心理念 | dsh 映射 |
|---|---|---|---|
| s10 | sandbox | 沙箱与统一执行世界：本地一键换远程 | `packages/e2b`、`packages/subprocess` |
| s11 | subagent | 子代理：委派与隔离 | `packages/subagent` |
| s12 | skills | 技能系统与后台工作流 | `packages/skill`、`packages/workflow` |
| s13 | persistence | 持久化：恢复、分叉、回放 | `packages/session` |

### 阶段五 · 组装与桥接

| 课 | 代号 | 核心理念 | dsh 映射 |
|---|---|---|---|
| s14 | bundles | profile 与 bundle：同一批插件组装出不同产品 | `packages/bundle/base`、`packages/boot/app-boot` |
| s15 | bridge | 桥接课：用真实 `@deepseek-ai/dsh-*` 包组装自己的 mini harness | npm 公开包 |
| s16 | recap | 全景回顾 + "Where new behavior goes" 实战地图 | `docs/architecture.md` |

课程映射的主题对应关系以本表为准；具体文件级链接在写作每课时补充。

## 仓库结构

```
learn-deepseek-harness/
├── site/                    # VitePress 站点
│   ├── .vitepress/          # 配置、rewrites、TimelinePage 等自定义组件
│   ├── index.md             # 首页
│   ├── timeline.md          # 时间线索引页
│   ├── glossary.md          # 中英术语对照
│   └── about.md             # 与 dsh 的关系、版本锚定说明
├── lessons/
│   ├── s01-min-loop/
│   │   ├── lesson.yaml      # 元数据：代号、行数、工具数、核心理念、dsh 映射锚点、验证过的版本
│   │   ├── README.md        # 课程文稿（唯一事实源，网站从这里投影）
│   │   └── src/             # 可跑代码 + smoke 脚本
│   ├── ...                  # s02–s16 同构
│   └── shared/mock-model/   # 共享 mock 模型适配器
├── scripts/                 # 元数据同步（统计行数/工具数写回 lesson.yaml）
└── package.json             # pnpm workspace
```

文稿与代码同目录，一处事实源；VitePress 用 `rewrites` 把 `lessons/sXX/README.md` 映射为 `/lessons/sXX/` 路由，不维护两份内容。

## 每课三段式结构

1. **为什么**（入门主线）：机制解决什么问题、没有它会怎样，配最小示意图。
2. **跑起来**：`pnpm --filter sXX dev` 直接跑；早期课程零依赖纯手写，中后期逐课复用上一课成果，代码随课程渐进长大。
3. **看真码**（进阶造读）：dsh 对应包导读（锚定版本号）+ 面向有经验读者的深挖段落。

## mock 模型适配器

`lessons/shared/mock-model` 回放脚本化的模型响应，保证无 `DEEPSEEK_API_KEY` 时 16 课全部可跑；每课留开关，设置了 key 则切换真模型。网站读者与 CI 都不依赖密钥。

## 网站页面

| 页面 | 内容 |
|---|---|
| `/` | Hero + 项目介绍 + 快速开始（克隆仓库、无 key 跑 s01） |
| `/timeline` | 核心索引页：5 阶段分组的课程卡片（编号、标题、行数/工具数徽章、核心理念、dsh 包徽章），底部代码量增长图 |
| `/lessons/sXX` | 课程页，由各课 `README.md` 投影 |
| `/glossary` | 中英术语对照，对齐 dsh `docs/glossary.md` |
| `/about` | 与 dsh 的关系、版本锚定说明 |

使用 VitePress 默认主题加少量自定义组件；行数、工具数等统计值由脚本从代码统计写入 `lesson.yaml`，页面只读元数据，不手抄。

## 版本锚定策略

dsh 处于 pre-release（仓库 git 历史显示最近发布 0.1.0-rc.5），上游明言此阶段会自由 rename/repackage。因此每课的源码导读链接与桥接课依赖都标注「验证过的版本号」；跟随上游升级是显式动作（改 lesson.yaml 里的锚点并重新验证），不静默漂移。

## 质量门与成功标准

- 每课一个 smoke 脚本：mock 模型下跑完并断言预期对话 transcript。
- CI（GitHub Actions）：全部 16 课 smoke + `vitepress build`，读者克隆即得绿色基线。
- 部署：GitHub Actions 构建发布 GitHub Pages。
- 成功标准：① 16 课全部无 key 可跑；② 网站公开可访问；③ s15 桥接课产出面向自己业务的 mini harness 雏形（学习目标的验收点）。

## 明确不做（YAGNI）

- 中英双语（后续按需加）
- 评论、账号、Analytics 之类的站点交互功能
- 页内在线沙盒（StackBlitz 等）
- 改造或提交内容给 dsh 上游仓库
- 自建组件库或深度定制 VitePress 主题
