# s15 · bridge：桥接课——用真实 @deepseek-ai/dsh-\* 包组装自己的 mini harness

> 前 14 课你写了一个教学 harness；这一课一个都不复制——直接依赖真实 npm 包，
> 把同一套概念在真包上重装一遍。

## 为什么

本课是系列的分水岭，先说清定位差异：s02–s14 是**复制前进**——每课拿前一课的
`src/` 叠加新能力，课程代码是自建的教学版（自己的 `defineTool`、自己的
`SessionLog`、自己的迷你 cordis）。本课**不复制前进**：`lessons/s15-bridge/`
是一个独立的最小项目，`package.json` 里依赖的是 npm 上公开发布的
`@deepseek-ai/cordis@4.0.1` 与七个 `@deepseek-ai/dsh-*@0.1.0-rc.8`（六个
插件树包 + `dsh-tool-todo` 工具包——后者留给「改两个地方」；精确 pin，逐包
`npm view` 核实，本课测试会锁死声明与安装一致）。课程自有代码一行
不进来——桥接的意义就是证明：**前 14 课教的概念就是真包的概念**。

同构到什么程度？本课跑的是 s01 的同款剧本（`add(2,3)` → `echo` 复读 →
终答），transcript 与 s01 逐行同构——但驱动循环的每一行都是生产代码：

| 本课组件（`src/`） | 用到的真实 API（全部核实过） | 前 14 课的对应 |
|---|---|---|
| `scripted-adapter.ts` 剧本 adapter | `class ScriptedAdapter extends LlmAdapter`，只实现唯一抽象方法 `stream(options)` 吐 `StreamChunk` 流；`ctx.llm.registerAdapter(['scripted'], adapter)` 注册 provider 路由 | s01 `mock-model`；s09「换 provider 整个世界跟着走」的 llm seam 现场 |
| `tools.ts` 工具定义 | `defineTool({ name, description, parameters, output: { schema, render }, execute })`——DSL 编译成 JSON Schema 进模型请求，`execute` 返回规范值、`render` 投影成模型可见块 | s02 `defineTool` 与工具注册表 |
| `harness.ts` 组装 | `new Context()` + 六个 `await ctx.plugin(...)` | s07/s08 迷你 cordis 与五件套插件化 |
| `index.ts` 驱动与打印 | `agent.followup(消息)` → `await agent.whenIdle()`；订阅 `session/event` firehose 打印 | s01 `runLoop`；s03 事件投影 |
| 会话日志 | `agent.session.events`（append-only） | s03 `SessionLog` |

**最小组装清单的权威出处是真包自己**：`AgentLoop` 的 `static inject =
['agents', 'sessions', 'llm', 'tools', 'systemPrompt']` 点名了五个服务，本课
挂的六个包正是这五个再加驱动器自己：`dsh-llm`（adapter 注册表 + 流式调用）、
`dsh-session`（事件日志）、`dsh-system-prompt`（提示装配）、`dsh-tools`
（工具注册表 + 执行管线）、`dsh-agent`（Agent 接口与注册表）、
`dsh-agent-loop`（turn/step 两级驱动）。挂载顺序无关紧要——cordis 会让每个
fiber 等自己 inject 的服务就位。

**无 key 的关键在 llm seam 的形状**：provider 面只有一个必须实现的方法
（`stream()`），`providerInfo`/`resolveModel` 都有默认实现——所以一个不到
40 行的剧本 adapter 就能顶替 DeepSeek provider 驱动整棵树。这不是投机取巧，
是上游自己的路：dsh 仓 `agent-loop` 的 keyless 测试就是 `MockAdapter extends
LlmAdapter` 挂在同一个 seam 上跑完整循环的。想换真模型时，同一位置换成
`@deepseek-ai/dsh-llm-deepseek`（一个 HTTP adapter 插件），组装面一行不动。

## 跑起来

```sh
pnpm --filter @learn-dsh/s15-bridge dev
```

不用任何 API key，预期输出：

```text
—— 用真实 @deepseek-ai/dsh-* 包组装的 mini harness ——
provider: scripted / model: mini-scripted（剧本 adapter，无 API key）
── turn 1 开始
[user] 帮我算 2 + 3
[assistant] 请求工具 add
[tool] 调用 add({"a":2,"b":3})
[tool] 工具结果：5
[assistant] 请求工具 echo
[tool] 调用 echo({"text":"2 + 3 = 5"})
[tool] 工具结果：2 + 3 = 5
[assistant] 2 + 3 = 5。这是真实 dsh 包上的一次完整运转。
── turn 1 结束
—— 模型面往返证据 ——
模型请求 3 次：
  第 1 次：1 条消息（user(1 块)）
  第 2 次：3 条消息（user(1 块), assistant(1 块), user(1 块)）
  第 3 次：5 条消息（user(1 块), assistant(1 块), user(1 块), assistant(1 块), user(1 块)）
第 2 次请求回喂的工具结果：{"type":"tool-result","toolCallId":"call-add","content":[{"type":"text","text":"5"}],"isError":false}
会话日志共 65 条事件（append-only，s03 的真身）
```

对照 s01 的输出：同样的剧本、同样的往返形状；多出来的是真包的账——65 条
事件里除了 transcript 级的 `user/message`、`tool/call`、`tool/result`、
`assistant/message`，还有 token 级的 `assistant/chunk`、请求头快照
`request/header` 等 s05/s06 才展开的原始级事件。建议按这个顺序读：

1. `src/scripted-adapter.ts` —— `textTurn`/`toolCallTurn` 两个剧本构造器给出
   `StreamChunk` 的最小合法序列（block-start → delta → block-end → usage →
   finish；finish 的 `tool-calls` 收尾就是循环去执行工具的驱动信号），
   `ScriptedAdapter` 记录每次请求供断言「模型到底看到了什么」。
2. `src/tools.ts` —— 真 `defineTool`：`parameters` 是逐属性 DSL
   （`{ a: { type: 'integer' } }`），`output` 声明规范值的 schema 与模型面
   渲染——工具结果回喂走的就是 `render` 的产物。
3. `src/harness.ts` —— 六个 `ctx.plugin` + `registerAdapter` + 工具注册，
   全课的「装配」就这么多。
4. `src/index.ts` —— 剧本、transcript 打印（`session/event` 订阅）、往返
   证据打印。
5. `src/bridge.test.ts` —— 四组断言：组装就位、DSL 投影、往返核心
   （第二次请求里 `toolCallId` 对得上的 `tool-result`）、依赖版本锁。

改两个地方感受一下：

- **再挂一个真实 dsh 工具包**：`@deepseek-ai/dsh-tool-todo` 已经在依赖里。
  在 `src/index.ts` 组装之后加两行：
  `import * as toolTodo from '@deepseek-ai/dsh-tool-todo'`、
  `await ctx.plugin(toolTodo, { allowParallelInProgress: true })`
  （这个 config 是必填的，dsh 例子的 cordis.yml 传的同一个值）。重跑后
  「模型请求」的 tools 名册里多了 `todo_write`——**工具名册来自挂载的插件**，
  这就是 s14「同一批插件组装出不同产品」的最小现场。测试第 4 条钉的就是它。
- **把剧本改一步**：`src/index.ts` 里把 `SCRIPT` 第一轮的参数改成
  `{ a: 40, b: 2 }`，同时把第二轮 echo 的文本改成 `'40 + 2 = 42'`——重跑，
  第一次工具结果变 42，第二次请求回喂的 `tool-result` 文本跟着变（工具真执行
  了，不是剧本背答案）。再把 `SCRIPT` 砍到只剩一条 `textTurn`，看单轮直答。

## 看真码（进阶导读）

真实 dsh 的包面可以按「底座 → 能力 → 产品」三层读，本课踩的是第一层半：

- **运行时底座**：`@deepseek-ai/cordis`（ctx/fiber/effect/waterfall——s07
  教的就是它的形状）+ `@deepseek-ai/schemastery`（配置 schema，作为 peer
  自动装入）。dsh 仓把 cordis vendor 进源码树并改 scope 发布，机制见
  [vendor/README.md](https://github.com/deepseek-ai/deepseek-harness/tree/master/vendor/README.md)
  （"publishing the harness publishes this framework layer too"）。
- **核心与能力**：本课六个包是核心；同一 npm scope 下还有完整的能力层
  （compaction、fs、shell、subagent、skill、web、session-persistence……），
  每个都是 `ctx.plugin` 挂载的插件——挂多少、怎么配，就是产品差异。
- **产品层**：真实产品不走本课的编程面 `ctx.plugin`，而是 Loader 加载
  cordis.yml 层叠（s14 的 patch/profile 机制）。

导读四站：

- [packages/llm/llm/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts)：
  llm seam 的 Service Definition。`LlmRuntime` 是 adapter 注册表 +
  `llm/stream` 瀑布可拦截的流式调用 API；`LlmAdapter` 的抽象方法只有
  `stream()`。本课 adapter 的每个 API 都来自这里。
- [packages/core/agent-loop/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/index.ts)：
  驱动器真身。`inject` 表是组装清单的权威出处；`create(id, options)` 是
  编程面创建 agent 的入口（产品面走 config 的 `agents` 数组声明）；
  turn/step 两级循环与 `followup`/`whenIdle` 生命周期。
- [packages/core/agent-loop/tests/mock-adapter.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/tests/mock-adapter.ts)
  与 [agent.spec.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/tests/agent.spec.ts)：
  上游自己的无 key 组装路径——`MockAdapter` 回放剧本 chunk，测试用与本课
  `harness.ts` 相同的六个 `ctx.plugin` 组装出完整循环。本课组装代码的出处。
- [packages/examples/agent-spine-demo/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/examples/agent-spine-demo/src/index.ts)
  与 [examples/headless-agent/cordis.yml](https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/headless-agent/cordis.yml)：
  同一组装的两个放大版。前者是产品级「全家桶」编程面装配（十几个包的
  `apply()`）；后者是声明式 YAML 组装——`llm-deepseek` 行换成剧本
  provider 就是无 key 等价物。

**差距声明（如实）**：本课是**编程面**的最小组装，离产品形态还差三层——
Loader/cordis.yml 声明式组装与 profile 层叠（s14）、持久化（`dsh-session-persistence`，
本课事件只在内存里）、以及全部能力插件。另一个真实差距是**版本预发布段**：
npm 上 dsh family 处于 `0.1.0-rc` 系列，`latest` dist-tag 与最新版本有漂移
（如 `dsh-llm` 的 `latest` 停在 `0.0.1-rc.1`，最新发布是 `0.1.0-rc.8`），且
序列里没有单独的 `0.1.0-rc.4/rc.5`（本地 dsh 仓 master 停在 `0.1.0-rc.5`
的 release commit，对应 npm 时间线上的 `0.1.0-rc.6`）。所以本课依赖全部
**精确 pin 到 `0.1.0-rc.8`**（cordis pin `4.0.1`），并在测试里逐包断言
「声明版本 === 安装版本」；`lesson.yaml` 的 `verifiedDshVersion:
0.1.0-rc.5` 指的是导读链接指向的 master 源码验证版本，本课写进 README 与
代码的每个 API 签名都对照 `0.1.0-rc.8` 安装包的 `.d.ts` 逐条复核过。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| npm family | @deepseek-ai/dsh-\* family | 同 scope 发布的包家族；cordis 运行时随之一体发布 |
| llm seam | LLM capability seam | LlmRuntime（服务定义）+ LlmAdapter（provider）+ 调用方（消费者） |
| 适配器 | adapter | provider 端实现；唯一必须实现 `stream(options): AsyncIterable<StreamChunk>` |
| 无 key 剧本 | scripted adapter | 回放预录 StreamChunk 的 adapter；教学与上游 keyless 测试共用此路 |
| provider 路由 | provider route | `registerAdapter(['名字'], …)` 占据的名字；agent 的 `options.provider` 指向它 |
| 类型级桥接 | type-level bridge | 本课**没有**走的兜底：只 import 真包类型、运行时用自家 mock——因真组装可跑而未启用 |
| 编程面组装 | programmatic assembly | `new Context()` + `ctx.plugin(...)`；与 Loader/cordis.yml 声明式相对 |
| 纤维 | fiber | cordis 的插件生命周期单元；卸载整棵树用 `await ctx.fiber.dispose()` |
