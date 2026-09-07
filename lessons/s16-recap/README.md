# s16 · recap：全景回顾——扩展点地图与通向你的业务

> 15 课你从零搭出了一个教学 harness；收官课只做两件事：把六个能力面串进同一轮对话，再把真仓的扩展点地图逐行对上你写过的代码。

## 为什么

s01 的 `runLoop` 不到 40 行；本课目录里的同一套代码已经是一个带权限、压缩、沙箱、委派、技能、
后台 job、持久化、profile 组装的小 harness——**每一层都是某一课的一次叠加**。收官课不再加新机制，
回答两个离开课程后立刻会遇到的问题：

1. **这些能力摞在一起是什么样？** s06 的压缩、s11 的委派、s12 的 job 各自在自己的课里演示；
   真实产品里它们**同一轮对话内并发协作**——本课的整合剧本跑一次给你看。
2. **以后想改东西，去哪儿改？** dsh 的 `docs/architecture.md` 有一张 "Where new behavior goes"
   表，18 行把「新行为挂到哪个扩展点」一次讲完。本课把它逐行翻译成「哪一课写过它、
   教学版里的对应物是什么」——这张表就是课程与真仓之间的总索引。

代码上本课只补了一件事：**把 persistence 行收进 BASE**（s14 时持久层留在运行时装配位，是底座
的缺口），并恢复 s12 真跑的 summary-report 工作流（s14 曾收成占位）。至此 BASE 十行齐了——
落盘是底座行为，resume 不再是演示特权。新代码很薄：一个 `Ctx.has`（装配期探测，不是运行时
兜底）、一个 `persistencePlugin`（种子历史经服务流向 tools 行）、BASE 一行、剧本与测试。

## 跑起来

```sh
pnpm --filter @learn-dsh/s16-recap dev
```

不用任何 API key，三幕（节选）：

```text
—— 序幕：装配——BASE 10 行（s16 补进 persistence 行），full 只重述权限规则 ——
  base 行表：model → persistence → tools → permission → compaction → world → subagent → skill → workflow → loop
  名册 17 工具；压缩阈值 1200；审批默认 ask。

—— 第一幕：整合剧本（full profile，一轮对话串起 s06/s09/s10/s11/s12/s13）——
  模型 ▸ 请求工具 load_skill(name=csv)
  system ▸ [skill: csv]
  模型 ▸ 请求工具 run_command(command=wc args=["-l","/sandbox/data/sales.csv"])
  模型 ▸ 请求工具 delegate(task=复核：读 /sandbox/data/sales.csv，……)
  工具 ▸ delegate → 子代理 sub-1 已完成（委派开销：1 轮 / 10 个事件；使用工具 list_dir、read_file）。
  工具 ▸ collect_job → job job-1（summary-report）：running（后台进行中……）
  ▸ 压缩检查点：前 13 条头部事实被摘要替代（估算 token 1248 → 382），被压事件仍在日志里
  工具 ▸ collect_job → job job-1（summary-report）：done——最终结果：
  审批问答 4 次：run_command、start_job、delegate、collect_job（全部批准）；
    第二次 collect_job 命中会话记忆（s04 的 remember），复用裁决不再问人。

—— 第二幕：进程重启——同一底座 resume 同一文件，turn 2 续聊（s13）——
  resume：重放 33 条事件重建日志；turn 从 2 续接，新事件 seq 从 33 续接。
  请求检查：重启后第一次模型请求包含「核账」与「8400」——记忆来自日志，不来自剧本自觉。

—— 收束：全链路 append-only 完整性 ——
  磁盘 37 条事件逐条与内存一致（含压缩检查点与两个 turn 的全部事实）。
  重放投影：仅凭文件重建的派生历史与活会话一致（11 条消息，含 system 规程与 summary）。
```

一轮对话读一遍，能看到课程的核心能力面在同一条时间线上协作：技能规程经 system 段生效（s12）、
两份大文件把派生历史顶过阈值、压缩在步骤边界落检查点（s06）、wc 在沙箱世界里数行（s10）、
后台 job 随每件 tool/result 推进（s12）、子代理在私有日志里复核、结论折叠成一对事件回父（s11）、
四条 ask 审批围住危险面（s04/s14）、每条事实落账即落盘（s13）——重启之后，同一个 full profile
从同一份底座 resume，模型仍记得上周的账。

本课新增两个文件，其余是对 s14 复制件的多处改动，建议按这个顺序读：

1. `src/integration.ts` —— 剧本与数据（演示与测试共用）：先看 `salesCsv`/`regionsCsv`
   （数据是确定性的函数产物）与 `REQUEST`（自检数字写进 user 正文——数字事实才能进压缩摘要，
   s06 摘要器只收对话正文的数字），再读 `TURN1_SCRIPT`：注意子代理的三条响应（c1/c2/回答）
   夹在父的 delegate 请求之后——**子代理继承父的模型实例**（s11），同一个 mock 按调用次序消费。
2. `src/bundles.ts` 的两处改动 —— BASE 的 persistence 行（在 model 之后、tools 之前：
   行序即挂载序，种子历史必须先到场）与真跑的 `summaryReportWorkflow`（对照 s14 的占位版本）。
3. `src/assemble.ts` 的 persistence case —— 「文件存在即 resume，否则物化新会话」的装配期
   决定；种子经 `persistence` 服务出场，tools 行用 `ctx.has('persistence')` 显式分支。
   `src/plugin-durable.ts` 的 `persistencePlugin` 是它的另一半（durable 挂成子插件，级联卸载）。
4. `src/recap.test.ts` —— 三个 describe：每个能力面至少一条事件/状态断言；resume 记忆延续
   （重启后第一次请求含「核账」与「8400」）；append-only 全链路（磁盘逐事件一致、重放投影一致、
   一事件一行）。

改两个地方感受一下：

- **在整合剧本里加一个环节**：在 `integration.ts` 的 `TURN1_SCRIPT` 里加两条响应——delegate
  之后让模型调 `write_file` 把复核结论写进 `/sandbox/report.md`，再照 t5 的样子在演示断言里
  加一条 `resultOf(events1, 'w1')`。注意审批从 4 次变 5 次（write_file 是 ask 面），
  turn 1 的事件数变了，第二幕的 resume 断言数字（33/37）要跟着改——**事件数是活的**，
  这正是 append-only 日志「一事件一行」的直接体感。
- **把 full 换成 safe 跑整合剧本**：把 `index.ts` 里两处 `FULL_PROFILE` 换成 `SAFE_PROFILE`。
  结局分三种：`list_skills`/`load_skill` 照常（allow 直通）；`delegate`/`start_job`/`collect_job`
  **连 schema 都不在名册**（s14 的「砍」——请求落「错误：没有叫 delegate 的工具」回喂）；
  `run_command` 在名册但直接 deny（「拒」——模型看得见、调得动、被围栏拦住）。剧本会先耗尽，
  因为 mock 还在按 full 的剧本走——这本身就是结论：**换 profile 换的是产品，剧本得重写**。
  顺带观察 safe 的压缩阈值 380：同样的数据在技能加载后就会压一次，比 full 早得多。

## 看真码：扩展点地图（Where new behavior goes ↔ 课程）

dsh 把「新行为挂到哪」写进 [docs/architecture.md 的 Where new behavior goes 一节]
(https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#where-new-behavior-goes)，
开头一句立场与整个课程同构："New behavior attaches to a documented extension point. Changing
the loop itself updates this map." 下面把它的 18 行逐行对上课程（教学版 = 本课 `src/` 里的
对应物；「未覆盖」是课程没教的面，如实标注）：

| dsh 扩展点（Goal → Mechanism） | 课程 | 教学版对应物 |
|---|---|---|
| Add a model provider → register its adapter on `ctx.llm` | s01 接口 · s09 换 provider · s15 真包组装 | `Model` 类型 + `modelPlugin`；s15 的 `ScriptedAdapter` 挂真包 llm seam |
| Add a model-facing capability → register on `ctx.tools`; its schema joins prompt assembly | s02 · s08 | `defineTool` + ToolRegistry → `tools` 服务，schema 每步重取 |
| Give one session a different capability set → compose an agent preset | s14 · s11 | FULL/SAFE 的名册行；delegate 的 `defaultTools` 白名单 |
| Add shell execution → register a `ctx.shell` backend | s10 | `ExecutionWorld.spawn` + `run_command`（Local/Sandbox 两个 Provider） |
| Add persistent terminal execution → `ctx.terminals` + dsh-tool-terminal | 未覆盖 | ——（教学版没有常驻终端面） |
| Add a human command → register on `ctx.commands`; dispatches without a model turn | 未单独开课；s04 近亲 | `askUser` 审批通道（工具执行中问人，不经模型轮） |
| Add background work → register on `ctx.jobs`; `job_*` tools collect or stop it | s12 | Job 注册表 + `start_job`/`collect_job`（start 与 collect 分离） |
| Add filesystem access or policy → register a `ctx.fs` provider or listen to `fs/*` events | s09 · s10 | `FsService` + Memory/Remote Fs；SandboxWorld 复用 RemoteFs 当虚拟 FS |
| Confine spawned processes → use a `ctx.sandbox` backend | s10 | SandboxWorld 的路径围栏（`WORLD_PATH_DENIED`，解释命令之前） |
| Intercept a request, tool, or turn → its `agent/*` or `tools/*` event | s02 钩子 · s04 守卫 · s07/s08 瀑布 | `tools/pre-execute` 异步瀑布；`agent/pre-step`（压缩挂在上面） |
| Add model-facing context → call `agent.inject()` | s12 | `load_skill` 注入 `system/message`（规程从此持续生效） |
| Add UI or editor integration → drive `ctx.agents`, render from `session/event` | s03 · s13 · s15 | `renderTranscript`（transcript 是日志的投影）；s15 订阅 `session/event` firehose |
| Add a Web Client Chat node → register a `ConversationNodeDefinition` | 未覆盖 | ——（web 客户端面，课程未涉） |
| Add durable session state → extend `SessionEventMap`; render and replay from the log | s03 → s06 → s12 → s13 | 往 `SessionEvent` 联合加分支：`session/compacted`、`system/message` |
| Generate session titles → register the sole `ctx.sessionTitle` provider | 未单独开课（s13 的持久化在位） | —— |
| Manage a same-session objective → use `ctx.goals` | 未覆盖 | ——（对应真仓 [packages/goal](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal)） |
| Fork a live session → `ctx.sessions.fork(source, boundary?, childSessionId?)` | s03 · s13 | `SessionLog.fork(boundary)` + `forkSessionFile`（谱系进支线头） |
| Scope a registration to one agent → use that agent's `agent.ctx` | s08 · s11 | `Ctx.mount` 的作用域级联回滚；子代理的 `childCtx`（互不可见） |

读法提示：表里「课程」列出现两次以上的行（shell/沙箱、事件拦截、持久事件、fork、作用域），
正是课程用多课打磨过的主干；「未覆盖」的行（terminal、commands、chat node、titles、goals）
是学完本课后拿着真仓文档就能自己走的路——每行的 Mechanism 列已经写清挂点。

### 通向你的业务

拿着业务需求回真仓，从这张表出发（路径均已核实存在于 [deepseek-harness 仓库](https://github.com/deepseek-ai/deepseek-harness/tree/master)）：

- **想加一个新工具**：s02 的定义与守卫管线 → s12 的技能附加工具（运行时进名册）。真仓读
  [packages/core/tools](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/tools)
  与 [docs/cookbook/adding-a-tool.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)
  （schema 进 prompt assembly、输出 schema 与 render 的规范）。
- **想换模型 / 加 provider**：s01 的最小接口 → s09 的 provider 切换 → s15 已用真包走过一遍
  （`ScriptedAdapter` 只实现一个 `stream()`）。真仓读
  [packages/llm/llm](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm)
  （adapter seam）、[packages/llm/llm-deepseek](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-deepseek)
  （HTTP adapter 插件的完整样例）与
  [docs/cookbook/adding-an-llm-adapter.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-an-llm-adapter.md)。
- **想换执行环境**（本机 → 沙箱 → 远程）：s10 的 ExecutionWorld 统一面就是为此设计的——工具
  零改动。真仓读 [packages/subprocess](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subprocess)
  （进程树 Provider）、[packages/fs/fs-sandbox](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/fs/fs-sandbox)
  （围栏 FS）、[packages/sandbox](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sandbox)
  （沙箱策略）与 [packages/e2b](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/e2b)
  （远程沙箱 POC）。
- **想改权限策略**：s04 的规则表与三态 → s14 的 profile 整行重述（一行 patch 换策略）。真仓读
  [packages/interaction/user-approval](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/interaction/user-approval)
  （审批通道）与 [packages/interaction/permission-presets](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/interaction/permission-presets)
  （read-only / workspace-write / danger-full-access 三预设——课程 full/safe 的真码形态）。
- **想加一个新能力 seam**（完整三角色清单，s09 的立论）：一个 seam 恰好三样东西，一件不少——
  ① **Service Definition**（能力词汇与服务契约）→ 真仓样例
  [packages/fs/fs](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/fs/fs)；
  ② **Service Provider**（实现契约、带来部署事实）→
  [packages/fs/fs-local](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/fs/fs-local)；
  ③ **Consumer**（模型面工具或其他消费方）→
  [packages/fs/tool-fs](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/fs/tool-fs)。
  三包的目录关系就是三角色的物理形态：Definition 不 import Provider，Consumer 只 import Definition。
- **想加持久事实 / 改会话语义**：s03 的词汇表 → s06/s12 各加一个事件的先例 → s13 的落盘与
  resume。真仓读 [packages/core/session](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/session)
  （SessionEventMap 与 fork）与 [packages/session/session-persistence-jsonl](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-persistence-jsonl)
  （JSONL 后端——本课持久化的真码同位物）。
- **想组装自己的产品**：s14 的三层（base → profile → patch）→ s15 的真包组装。真仓读
  [packages/bundle/base](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/base)
  （dsh-base patch）与 [examples/headless-agent](https://github.com/deepseek-ai/deepseek-harness/tree/master/examples/headless-agent)
  （一份 cordis.yml 直接组装的示例——下一站的动手起点）。

[docs/cookbook/extension-cookbook.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)
把功能映射到能力并索引了上面这些逐步指南（packages / tools / LLM adapters / Chat nodes）——
它是这张地图的下一层。

本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

## 术语总表

16 课术语的精选汇总（每条标注首次完整出现的课）：

| 中文 | 英文 | 备注 |
|---|---|---|
| 循环 / 驱动器 | agent loop / driver | s01；模型 ↔ 工具的往复，一切的地基 |
| 轮 / 步 | turn / step | s01；一次用户意图的完整生命周期 / 一次模型请求 |
| 剧本模型 | mock model | s01；回放预录响应，测试与演示不依赖真模型 |
| 参数校验 | JSON-Schema validation | s02；校验失败是回喂的 tool result，不是崩溃 |
| 守卫 / 预执行拦截 | pre-execute guard | s02/s04/s08；否决以文本回喂，模型能读懂并改道 |
| 追加式事件日志 | append-only session log | s03；只增不改，模型的记忆与真理之源 |
| 派生历史 | derived messages / projection | s03；模型可见历史从日志投影，不是存出来的状态 |
| 重放 / 分叉 | replay / fork | s03/s13；仅凭事件重建状态 / 从边界分出新会话 |
| 权限三态 | allow / deny / ask | s04；ask 无通道时退化为 deny（fail-safe） |
| 会话记忆 | remembered decision | s04；同工具复用裁决——省事，但授权会漂移 |
| 错误分流 | tool-level vs model-level | s05；工具层回喂可恢复，模型层收口上抛 |
| 取消信号 | AbortSignal | s05；贯穿模型调用与工具执行，取消也写 turn/end |
| 上下文压缩 | compaction | s06；摘要替代头部，被压事件仍在日志里 |
| 尾部窗口 | keep-tail window | s06；压缩后原样保留的最近 N 条消息 |
| 可逆注册 | registrations are effects | s07；注册即返回清理函数，卸载即逆序回滚 |
| 拦截链 | waterfall | s07；监听者必须 `next()` 委托，不调即短路 |
| 能力缝三角色 | Definition / Provider / Consumer | s09；一个能力的三件套，缺一不成 seam |
| 执行世界 | execution world | s10；统一 fs + subprocess，本地与沙箱一键互换 |
| 子代理 | subagent | s11；私有日志 + 受限名册，父只见一对事件 |
| 技能 | skill | s12；规程注入 system 段 + 可选附加工具 |
| 后台工作流 | background job / workflow | s12；start 与 collect 分离，主循环不阻塞 |
| 会话文件 | session file (JSONL) | s13；一事件一行，头行带格式版本与谱系 |
| 崩溃尾巴 | torn tail | s13；committed 区损坏拒绝，尾部残迹截断修复 |
| 底座 / 产品形态 / 补丁 | base / profile / patch | s14；同一批插件，不同的一叠数据 |

## 下一站

课程到此闭环。三条路任选，顺序也无所谓：

1. **读 [docs/architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
   全文**：你已经能读懂它的每一节——Turn flow 是 s01/s05、Session log 是 s03/s13、Capability
   seams 是 s09、Profiles and bundles 是 s14；这次带着「我写过它的教学版」的地图读。
2. **跑真仓的 [examples/](https://github.com/deepseek-ai/deepseek-harness/tree/master/examples)**：
   [headless-agent](https://github.com/deepseek-ai/deepseek-harness/tree/master/examples/headless-agent)
   一份 cordis.yml 组装最小 agent（s15 已走过同款路），acp-agent / jsonrpc-agent 是它换前端
   协议的变体——对照 s14「同一底座，不同层叠」。
3. **给自己的业务画第一个 cordis.yml**：从「通向你的业务」里挑一条最近的路——多数业务只需要
   一个工具（s02）加一个 profile（s14）。画完拿 `--dump-config` 对照（s14 讲过的离线检查面），
   你的第一个产品形态就立起来了。

遇到没教过的面（terminal、goals、commands、chat node……），回 "Where new behavior goes" 表
查一行——挂点写在那里，课程教的 seam 思维在那里全部适用。
