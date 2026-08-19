# s08 · plugins：把 s01–s06 的成果拆成插件——核心五件套如何协作

> 插件化的检验标准不是「能挂载」，是「同一剧本、同一行为，但每一件都能单独换掉、单独拆掉」。

## 为什么

s07 结尾留下一条没接的线：s04 的权限守卫还是循环参数，压缩还是 `runLoop` 的
`compaction` 参数——每换一个策略都得改装配代码。本课兑现 s07 的预告：**五件套
全部改写为挂进 `Ctx` 的插件**，s06 的三幕剧本原样重跑，整份会话日志与旧
`runLoop` 逐事件相等（测试钉住）——**重构不改行为**，然后才谈替换与拆装。

| 插件（src/plugin-*.ts） | 贡献服务 | 消费谁 | 挂哪个事件 | dsh 对应 |
|---|---|---|---|---|
| model | `model`（适配器本体） | — | — | `llm/llm` 贡献 `ctx.llm`，provider 插件注册其上 |
| tools-session | `tools`（名册+执行）、`sessions`（日志+落账即广播） | — | 发起 `tools/pre-execute`、广播 `session/event` | `core/tools` + `core/session`（两个包，见下） |
| permission | 无（纯拦截插件） | `tools` | `tools/pre-execute`（异步拦截链） | 审批能力监听 `tools/pre-execute` 瀑布 |
| compaction | 无（纯拦截插件） | `sessions` | `agent/pre-step`（异步拦截链） | `compaction/compaction-basic` 监听同事件 |
| loop | `agent`（`run()`） | `model`、`tools`、`sessions` | 发起 `agent/pre-step`、emit `agent/step` | `core/agent-loop`（inject 声明五服务） |

五件套的协作全在 **seam** 上：插件之间不 import 彼此的实现，只通过服务贡献
（`ctx.service`）、服务消费（`ctx.get`）、事件拦截（`ctx.on` + waterfall）、事件观察
（`ctx.on` + emit）四种动作协作。事件键与服务键都用声明合并进目录
（`EventMap`/`ServiceMap`），且**由生产者声明**：`tools/pre-execute` 与 `session/event`
声明在 plugin-tools-session.ts，`agent/pre-step` 声明在 plugin-loop.ts——
消费插件一个字都不用改目录。

**为什么 loop 不再是「主程序」而是「协作的驱动者」。** 旧 `runLoop` 自己落账工具
事件、自己评估压缩、自己持有守卫数组；新的 loop 插件每步只剩三次协作——发起
`agent/pre-step` 瀑布（压缩挂上面）、emit `agent/step`（观察者挂上面）、把工具调用
交给 `tools` 服务执行（拦截链在它里面）。循环体只剩「调模型、决定停不停」。取舍：
loop 做成插件而不是消费 ctx 的普通函数，因为做成函数它就还不是可替换、可卸载的
单元——「换一个驱动器」（流式、并行工具调动）应当是换一行装配，不是改组装代码。
dsh 同款立场：默认驱动 `core/agent-loop` 本身就是插件。

**为什么本课要给 Cordis 补异步瀑布。** s07 的 `waterfall` 是同步链——但裁决不总是
同步能落定的：审批要等人的回答（ask 分支）、压缩要等摘要器（真模型课是等一次
LLM 调用）。本课在 cordis.ts **叠加** `waterfallAsync` 与第三种事件 mode
（`waterfall-async`）：监听器可返回 Promise，语义与同步链完全相同（必须 `next()`
委托、不调即短路），同步链原样保留（s07 的测试钉住它的语义）。真 Cordis 的
waterfall 本就组合 Promise——s07 收的是简化，本课补齐。`tools/pre-execute` 与
`agent/pre-step` 两个键都是异步瀑布，且直接用 dsh 的真名。

**s07 未接的线在本课合流。** s04 的守卫是 `preExecute` 数组的一项，s07 的 guard
是同步拦截器（教学演示）；现在 `createPermissionGuard` 的产物被包成
`tools/pre-execute` 链上的一个监听器——守卫代码一行未改（permission.ts 原样复制
前进），裁决轨迹逐条一致（测试断言）。否决=不调 `next()`：链短路、工具体不执行、
理由由 tools 服务落成回喂模型的 `tool/result`（对话的一部分，不是崩溃）——s02
管线的回喂规矩、s04 的 fail-safe、s07 的短路语义，三课在同一个监听器里合流。

**落账即广播。** `sessions` 服务的 `append` 做两件事：写日志 + emit `session/event`
（dsh 同名事件：SessionStore 在 append 后的 fire-and-forget feed）。tool/call、
tool/result、session/compacted……每条事实落账的瞬间就被广播——任何插件不 import
日志实现就能观察全部会话事实，这是「第六插件」的天然挂点；压缩事件也走这条通道
（否则它会成为广播流里看不见的事实，测试钉住）。

## 跑起来

```sh
pnpm --filter @learn-dsh/s08-plugins dev
```

不用任何 API key，三幕 + 收束（完整输出含每步细节，此处节选）：

```text
—— 第一幕：五件套插件组装，s06 剧本原样重跑 ——
已挂载插件：observe、model、tools-session、permission、compaction、loop
  [observe] agent/step 1-1
  [observe] tools/pre-execute → 放行（search_logs）
  ……
  [observe] session/compacted：压掉 5 条头部，估算 818 → 449 token
账本 22 个事件、压缩 1 次；最终回答：我们的集群一共 47 台节点——……
与 s06 快照的等价由测试钉住：整份日志逐事件相等（plugins.test.ts 第一组）。

—— 第二幕：换更严的 permission 插件（deny 危险工具），其余零改动 ——
  [observe] tools/pre-execute → 否决（search_logs）
账本 21 个事件：三次 search_logs 全被拦下，tool/result 只有 3 条否决文本
    守卫否决：权限拒绝：策略把 search_logs 标记为 deny；如需完成目标，请改用其他工具
对照第一幕：回喂从 3×24 行日志变成 3 条否决文本，预算不再超阈值——压缩 0 次。

—— 第三幕：换 compaction 插件的摘要器，压缩时机不变、检查点内容即变 ——
压缩发生在同一步骤边界：压掉 5 条头部，估算 818 → 360 token（第一幕：818 → 449）
第一幕的摘要（确定性摘要器——机械保留要点与数字事实）：
  早期对话共 5 条消息的摘要。
  数字事实：47。
第三幕的摘要（极简摘要器——只报条数）：
  极简摘要：早期 5 条消息。

—— 收束：卸载插件响亮报错，不静默空转 ——
卸载 model 插件后：已挂载 tools-session、permission、compaction、loop
agent.run("随便问点什么") → 没有叫 "model" 的服务（当前服务：sessions, tools, agent）
日志事件数：0（零事件——报错发生在第一个事实落账之前，不是空转半截 turn）
```

本课新增五个插件文件、cordis.ts 叠加一种分发模式，建议按这个顺序读：

1. `src/cordis.ts` 的 `waterfallAsync`（与 `AsyncWaterfallEvent`）——本课唯一的
   机制增量：异步拦截链，s07 的一切零改动。
2. `src/plugin-model.ts` —— 最小插件：一个工厂参数、一个服务贡献。真适配器
   与 mock 同位。
3. `src/plugin-tools-session.ts` —— 本课最重的文件：一个插件贡献两个服务
   （`tools` 执行运行时、`sessions` 落账即广播），`execute` 复刻 s02 管线语义
   （校验在链前、否决回喂、取消上抛），内置行为=执行工具体。
4. `src/plugin-permission.ts` —— 合流点：s04 守卫挂上异步链；否决即短路。
   带 `guard` 引用供读裁决轨迹。
5. `src/plugin-compaction.ts` —— dsh 同款挂法：`on('agent/pre-step')` 压缩后
   `next()` 委托；落账走 `sessions.append`（压缩事件也广播）。
6. `src/plugin-loop.ts` —— 驱动者：`run` 与旧 `runLoop` 逐行为等价，差别只在
   依赖从参数变成服务、压缩从参数变成瀑布上有没有人。旧的 `agent.ts`
   （`runLoop`）原样保留：它是等价性测试的对照基线。
7. `src/index.ts` —— 组装器，也就是本课「主程序」的全部：`assemble()` 挂六个
   插件、三幕换件重跑、收束卸载演示。`observePlugin` 是第六插件（临时演员）：
   只挂三个事件监听，不贡献任何服务。
8. `src/plugins.test.ts` —— 四组断言：等价（逐事件+模型请求）、换件差异、
   卸载响亮、广播对齐。

改两个地方感受一下：

- 写你自己的第六插件：在 `src/index.ts` 里复制 `observePlugin`，改成只挂一个
  `ctx.on('session/event', ({ event }) => console.log(event.type))`——五件套零改动，
  你已经能看到全部 22 个事实的落账流。再进一步：给它加一个
  `ctx.on('tools/pre-execute', async (decision, next) => next({ ...decision, args: { ...decision.args, query: 'audited:' + String(decision.args.query) } }))`
  ——拦截器的**改写**路径：落账的 tool/call、工具输出、压缩预算全都跟着变，
  而工具体与 permission 插件一行都不知道有这回事；
- 换 model 插件跑另一个剧本：把 `SCRIPT` 换成 s01 的 add/echo 剧本（或任何
  `createMockModel([...])`），`assemble()` 一行不改照跑——「换模型」与「换剧本」
  对其余四件套是同一件事：换一个插件实例。

## 看真码（进阶导读）

dsh 的口号「everything is a plugin」在本课全部落地，五件套在真仓各有其身——
相互发现的方式是 **service 注入**（`inject` 声明 + 装配期解析）：

- [docs/architecture.md 的 Cordis 一节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#cordis)：
  「Every part of the product is a plugin, including the model adapter, the
  tool registry, the session log, and the agent loop itself」——没有特权核心，
  扩展 dsh 就是在别人旁边再挂一个插件。
- [packages/core/agent-loop/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/index.ts)：
  `AgentLoop extends Service`（`super(ctx, 'agentLoop')`）且
  `static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']`——
  **驱动器声明它消费谁**。教学版用 `ctx.get('model')` 显式读取；真 Cordis 的
  inject 是装配期机制：依赖不齐插件不加载、服务注销时依赖它的插件自动卸载——
  所以真版 `ctx.get` 返回 undefined 也不危险（s07 讲过这对取舍，教学版按
  「misconfiguration fails loud」当场报）。
- [packages/core/agent-loop/src/agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts)
  的 `preStep()`：`this.dispatch.waterfall('agent/pre-step', { messages, turn,
  step, signal }, 内置行为)`，随后 `this.loopCtx.llm.stream(request)`——loop 的
  每步就是「发起瀑布、调 llm 服务」两件事，与教学版 plugin-loop.ts 逐行同构。
- [packages/core/tools/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/index.ts)：
  `ToolRuntime extends Service`（`super(ctx, 'tools')`，`static inject = ['systemPrompt']`），
  Events 声明 `tools/pre-execute`（@mode waterfall，ask 决议经审批服务）、
  `tools/execute`、`tools/post-execute`（三段瀑布）与 `tools/result`、
  `tools/change`（emit）——教学版把执行管线折叠进 `tools` 服务的 `execute`，
  真版把 pre/around/post 全部摊成事件。
- [packages/core/session/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/index.ts)：
  `SessionStore extends Service`（`super(ctx, 'sessions')`）；`session/event`
  的 JSDoc 写明「Post-commit, fire-and-forget append feed」——教学版
  `sessions.append` 落账即广播的就是这条 feed。
- [packages/compaction/compaction-basic/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/index.ts)：
  `BasicCompactionEngine` 的 `static inject = ['llm', 'tokenMeter', 'sessions']`，
  `ctx.on('agent/pre-step', …)` 里压缩、然后 `return next()`——教学版
  plugin-compaction.ts 的逐字原型；差异是它还带 Config schema（阈值比率等
  由 cordis.yml 行配置）与失败 containment（压缩失败 warn 后继续 turn）。
- [packages/llm/llm/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts)：
  `LlmRuntime extends Service` 声明合并 `Context.llm`，`llm/stream` 是
  @mode waterfall（retry、replay、routing 的拦截点）——教学版 model 插件
  贡献裸适配器，真版是「运行时服务 + 多 provider 注册」两件套。
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：inject 的依赖等待与自动卸载、Config
schema 与 cordis.yml 装配行（教学版用工厂参数承载）、capability seam 的三角色
拆分（Service Definition / Provider / Consumer——教学版把 tools 与 session 合在
一个插件里，拆开的时机是两者开始被不同插件独立替换：s09 的主题）、scope 与
按插件拦截配置。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 五件套 | five-piece core | model / tools+session / permission / compaction / loop |
| 能力缝 | seam | 插件协作的接触面：服务与事件，不是实现 import |
| 服务贡献 | provide / service() | 教学版 `ctx.service`；真 Cordis Service 基类 |
| 服务消费 | consume / get() | 教学版显式 get；真版 inject 声明等待 |
| 依赖声明 | inject | 真 Cordis：依赖不齐不加载、注销时自动卸载 |
| 异步拦截链 | waterfall-async | 本课第三种 mode：监听器可返回 Promise |
| 装配 / 组装 | assemble | 挂插件清单；真版是 cordis.yml 的层叠行 |
| 驱动器 | driver / loop plugin | loop 从主程序降为五件套之一 |
| 观察者 | observer | 只挂 emit 监听的插件（本课的 observe） |
| 生产者声明 | producer declares | 事件键写在发起方插件里，消费方零改动 |
| 落账即广播 | append-then-broadcast | sessions.append 写日志 + emit session/event |
| 换插件 = 换世界 | swap a plugin, swap the world | 换实例不改代码，行为即变 |
| 等价重构 | behavior-preserving refactor | 逐事件相等测试钉住 |
