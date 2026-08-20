# s11 · subagent：子代理——委派与隔离

> 检验标准不是「能再开一个循环」，是「父把任务交出去之后，父的上下文、子的上下文、子的能力边界三者互不渗透，而父拿回结构化的结果」。

## 为什么

s10 结尾留了一个问题：把一个受限工具集 + 私有日志的子代理放进这个世界里委派任务。
这节课就是它。**委派**（delegation）解决的是上下文经济学：让模型读二十个文件再汇总，
二十次工具往返全部进父的历史——上下文以 O(工作量) 增长，很快撑爆窗口。委派把「读+筛」
打包给一个子代理（subagent）：它在自己的上下文里干活，父只收**结论**——父的增长是
O(委派次数)，不是 O(子的步数)。

但「开一个循环」很容易，「隔离」才是设计。隔离有三面，缺一面委派就变质：

- **上下文**：子代理有自己的事件日志（自己的 `SessionLog` 与派生历史）。子看不到父的
  对话，任务文本必须自包含；父也看不到子的过程——父日志里这次委派只增加一对
  `tool/call` + `tool/result`，子的全部中间事件留在子的私有日志里，**单独可查**
  （`subagents.logOf(id)`）。dsh 原话说的就是这件事："the parent's log records only
  the spawn `tool/call` and its `tool/result`, while child steps and tool calls remain
  outside the parent log"。
- **权限/能力**：子的工具集是**显式传入的白名单**，不是父名册的全量。子调白名单外的
  工具，得到的是响亮的「没有叫 "write_file" 的工具（当前名册：…）」回喂——能力边界
  是可观察、可修正的事实，不是静默的空操作。
- **可观察性**：子的账本独立成册，审计子的工作去读子的日志；父的 transcript 保持干净。
  隔离不是丢失信息，是**信息的分层归属**。

为什么工具集显式传入而非默认全量？因为「默认全量」意味着每次委派都在复制父的全部
权力——委派本该**缩小爆炸半径**：把「统计文件」交给一个只会读的子代理，就算模型的
任务写歪了，它能造成的最大伤害也就是读错文件。显式白名单还有一层可审计性：装配处
一行名单就是子的能力清单，review 它等于 review 委派策略。要诚实的一点（dsh 反复强调）：
这是**可见性**（visibility）不是**权威**（authority）——同一进程里的工具实现并没有被
沙箱化，dsh 的 toolFilter 同样"changes the child view … but is not a parent-derived
authority ceiling"。真正的进程级隔离是 out-of-process 传输（ACP / Codex / Claude Code）
的事，见「看真码」。

**防无限递归要两道闸。** 子代理一旦能用 delegate，就可能再开子代理、再再开——无限
递归在结构上是可能的。第一道闸在**装配期**：delegate 的默认白名单不得含 delegate
自己，含即构造当场抛错（fail loud）——子代理的默认能力里根本没有委派。第二道闸在
**运行期**：调用方（模型）显式点名 delegate 是合法的（受限工具集允许递归），由**绝对
深度上限**兜底——深度从顶层 0 起、每层 +1，上限默认 2（子可以出生、孙可以出生、
曾孙被拒）；拒绝发生在 spawn **之前**：没有子装配、没有子日志、零副作用，错误作为
带补救语的 tool/result 回喂给试图委派的那个代理，它看得见、能改道。dsh 的立场一字
不差："Without a bound, an in-process child can see the delegation tool and recurse"，
所以 in-process provider 实现 depthLimit，而拒绝是 errored tool result。

| 角色 | 本课文件 | 职责 | dsh 对应（subagent seam） |
|---|---|---|---|
| Service Definition | `subagent-service.ts` | 请求/结果/句柄词汇、`SUBAGENT_DEPTH_EXCEEDED`、`subagents` 键 | packages/subagent/subagent（SubagentRuntime + types.ts） |
| Service Provider | `subagent-provider.ts` | in-process spawn：子装配 + 驱动 + 结果折叠 | subagent-spawn-in-process + 共享 driver subagent-in-process-driver |
| （服务注册） | `subagent-plugin.ts` | 编号、域校验、子日志查询 | SubagentRuntime 的注册表层 |
| Consumer | `subagent-tools.ts` 的 `delegate` | 模型面 schema、白名单解析、开销回喂 | packages/subagent/tool-subagent（`subagent` 工具） |
| （装配） | `index.ts` 的 `subagentPlugin(...)` 行 | 显式选定 provider | cordis.yml 的 provider 行 |

spawn 的形状：`spawn({ task, toolset, depth?, maxDepth?, signal? }) → handle`——
一段自包含任务 + 一份显式白名单；`await handle.result` 拿
`{ answer, stopReason, toolsUsed, eventCount, turns }`：**answer 是结论，其余是委派
开销的账目**。父侧的 delegate 工具阻塞等子跑完，把回答与开销一起回喂；收完即
`dispose`（逆序卸载子的整个装配——s07 的效果清单在子代理身上的回响）。

两个值得知道的取舍：**子的工具是同一批对象**——toolset 里传的是委托方名册里的那些
Tool（工具体闭包绑定父装配容器），子执行它们时照常解析父的服务（fs 工具落到父的执行
世界，父写的文件子读得到——s10 的「世界是部署级共享」在委派下不变），受限的只是
**名册**；**深度经克隆链传递**——教学版的工具没有执行上下文携带代理身份（dsh 的
`exec.agent` → `delegationDepthOf`），子拿到的是 depth+1 的 delegate 克隆，深度挂在
工具实例上逐层传。

顺带一提：本课修掉了复制链从 s08 带来的一个缺口——tools 服务在「未知名 / 非法
JSON / 参数校验不过」三条早退路径上不落 `tool/result`（函数版管线没这个洞，s08 把
落账挪进服务时漏了）。受限工具集的「响亮报错回喂」靠的正是这条路径，测试钉住它。

## 跑起来

```sh
pnpm --filter @learn-dsh/s11-subagent dev
```

不用任何 API key，两幕 + 收束（节选）：

```text
—— 第一幕：把「统计文件」委派出去（子的默认白名单 read_file/list_dir，不含 delegate） ——
  [delegate] 列出 /sandbox/reports 目录下的全部文件…（默认白名单）
    回喂 → 子代理 sub-1 已完成（委派开销：1 轮 / 13 个事件；使用工具 list_dir、read_file）。
           …reports 目录共 2 个文件：alpha.md 3 行、beta.md 5 行，合计 8 行。
父的最终回答：委派完成——子代理统计出 reports 共 2 个文件、合计 8 行……
子代理 sub-1 的私有日志（单独可查，共 13 个事件，使用工具 list_dir、read_file）：
  turn/start → user/message → assistant/message → tool/call → tool/result → … → turn/end
隔离对照：父日志 7 个事件、0 条来自子代理内部；子的任务文本与全部工具往返只在子的日志里（13 个事件）。
  父：turn/start → user/message → assistant/message → tool/call → tool/result → assistant/message → turn/end

—— 第二幕：显式递归与深度上限（maxDepth 默认 2：孙可以出生，曾孙被拒） ——
  [delegate] 统计 /sandbox/notes.md 的总行数…（显式工具集：delegate、read_file、list_dir）
    回喂 → 子代理 sub-1 已完成（委派开销：1 轮 / 7 个事件；使用工具 delegate）。
深度拦截回喂（在孙 sub-2 自己的对话里）：工具执行出错：子代理委派深度 3 超过上限 2
  （SUBAGENT_DEPTH_EXCEEDED） —— 请不再向下委派，改用你当前可用的工具完成任务
第二幕共启动 2 个子代理（sub-1=子、sub-2=孙）——深度 3 的第 3 个从未出生：spawn 在启动之前被拒。

—— 收束：防递归的两道闸，与委派的上下文经济学 ——
① 装配期闸：defaultTools 塞进 'delegate' → delegate 工具（"delegate"）的默认白名单不得包含自己……
② 运行期闸：显式点名 delegate 合法，由绝对深度上限兜底——拒绝发生在 spawn 之前，零副作用、错误回喂。
上下文经济学：两幕的父日志各 7/7 个事件，三个子日志合计 30 个事件——
  父的增长是 O(委派次数)，子的账本各自独立、经 subagents.logOf 单独可查。
```

本课新增五个文件，建议按这个顺序读：

1. `src/subagent-service.ts` —— Definition：请求（task + 显式 toolset + depth/maxDepth）、
   结果（answer + 开销账目）、`SubagentRun`/`SubagentHandle`、深度错误码。以及为什么
   没有默认工具集。
2. `src/subagent-provider.ts` —— in-process Provider：深度检查（启动之前）、子装配
   （子 ctx 上三件套：继承的模型 + 受限名册与私有日志 + loop）、结果从子日志折叠
   （answer = 最后一条非空 assistant 消息）。
3. `src/subagent-plugin.ts` —— 服务注册：编号、maxDepth 域校验、logOf。注意它有多薄
   ——spawn 的全部实质都在 provider，这正是 seam 的分工。
4. `src/subagent-tools.ts` —— Consumer：`delegate` 工具。白名单解析（显式点名
   delegate 时造 depth+1 克隆）、阻塞等结果、开销回喂、契约内拒绝补补救语。
5. `src/index.ts` —— 装配器与三幕演示：委派统计、显式递归被深度拦下、两道闸。
6. `src/subagent.test.ts` —— 五组断言：结构化结果与 logOf、父/子日志隔离、
   白名单外响亮回喂、深度上限（回喂 + 零副作用 + 域校验）、结果回喂父可引用、
   装配防线。

改两个地方感受一下：

- **给子代理扩一个工具**：把 `index.ts` 装配处 `assemble(...)` 的默认白名单
  （`delegateDefaults`，默认 `['read_file', 'list_dir']`）加上 `'write_file'`，再在第一幕
  剧本里让子代理先 `write_file` 一份摘要再读回。从「没有叫 "write_file" 的工具
  （当前名册：read_file, list_dir）」变成真的写入——子的能力边界就是这一行名单，
  世界、工具实现、父装配一个字没改。反过来把 `'read_file'` 删掉，子就只能列目录
  ——「统计」任务立刻做不动，能力边界肉眼可见。
- **把深度上限调成 1**：把 `delegateTool(ctx, { ... })` 加上 `maxDepth: 1`，重跑第二幕。
  子还能出生（深度 1 ≤ 1），但子的 delegate 调用**第一跳**就被拒（子代理委派深度 2
  超过上限 1）——孙不再出生，子直接改用自己的工具完成。对照默认 2 的行为差异：
  递归被允许的层数就是这一个数字，「小而有限的默认」是 dsh 与本课共同的立场
  （dsh 默认 3）。

## 看真码（进阶导读）

dsh 的 subagent 是一个完整的 capability family（一个 Service Definition + 五种传输
provider + 三个模型面工具），本课是它的一次性委派（one-shot）、in-process 那一格的
教学投影：

- [packages/subagent/README.md](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent)
  的家族表：`subagent/`（定义 `ctx.subagents`）、`subagent-spawn-in-process/`（fresh
  child）、`subagent-fork-in-process/`（从父的已完成 turn 播种）、`subagent-acp/` 与
  `subagent-claude-code/`、`subagent-codex/`、`subagent-dsh-sdk/`（跨进程传输）、
  `tool-subagent/`（模型面工具）。教学版的单 provider 在这里是七选一再多传输共存。
- [packages/subagent/subagent/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/src/types.ts)：
  契约原文。`SubagentStartRequest` 的 `maxDepth`（绝对上限）与 `toolFilter`（受限
  工具视图，"the named tools vanish from the child's prompt AND refuse to execute (one
  visibility)"——一次可见性，schema 和执行一起拒）；`SubagentResult` 的 output 选择
  规则；`SubagentRun` 的「result 不因子的失败而 reject」。还有
  `SubagentCapabilities`——provider 声明自己支持哪些 start-time 能力，服务在委派
  **之前**校验，不支持就 `UNSUPPORTED_CAPABILITY`（fail loud，不 accepted-then-ignored）。
- [packages/subagent/subagent/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/src/index.ts)：
  SubagentRuntime——named-provider registry（"Unlike the bash seam (one executor per
  context, second load throws), MULTIPLE providers coexist here"）。
  `subagent/start`/`subagent/end` 生命周期事件对（观察者挂这里，不碰 run）。
- [packages/subagent/subagent/src/depth.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/src/depth.ts)：
  深度词汇：`delegationDepthOf`（持久化的 session header 是单调下限——重启不能把子
  代理重新数成顶层）与 `assertSubagentMaxDepth`（负数/分数/负零/非安全整数全拒）。
  教学版的 depth 克隆链是真仓「深度落在子代理的持久身份上」的运行时替身。
- [packages/subagent/subagent/src/child-agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/src/child-agent.ts)：
  `resolveChildDepth`（子深度 = 父 + 1，超 cap 抛 `SubagentDepthError`——教学版
  provider 里那五行检查的真身）与 `applyChildComposition`（子代理 join 父的 preset
  组合再叠自己的 persona/toolFilter——教学版收窄成「继承模型 + 白名单」两件）。
- [packages/subagent/subagent-spawn-in-process/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-spawn-in-process/src/index.ts)：
  spawn provider：`inheritsParentContext = false`（fresh child 看不到父对话——所以
  任务必须自包含，工具的 schema 描述据此措辞）；capabilities 四项全开（它控制子的
  创建窗口，所以四项都能强制执行）。
- [packages/subagent/subagent-in-process-driver/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-in-process-driver/src/index.ts)：
  共享驱动 `startInProcessRun`：深度检查 → 创建子 Agent → 投递 prompt → 等空闲 →
  `readResult` 从子日志折叠结果（`finalAssistantOutput`，turn 结束原因映射 stopReason
  ——教学版 `outcomeOf` 的对照真身）。
- [packages/subagent/tool-subagent/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/tool-subagent/src/index.ts)：
  模型面工具的真身：config 绑定一个 provider 名（模型看不到传输选择）、`maxDepth`
  默认 3（`0` 禁止一切委派）、foreground 路径 await result 后必 dispose、非 completed
  的 stopReason 变 errored tool result 且保留子的部分输出
  （"a truncated answer is never reported as success yet never silently lost"）。
  `providerWording` 按 `inheritsParentContext` 换 schema 措辞——fork 的子看得见父的
  已完成 turn，告诉它「重新描述一切」就是撒谎。
- [.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)：
  seam 的决策原文。"Child isolation and the parent log" 一节是本课隔离主张的出处；
  "Why not the bash seam shape" 解释为什么这里是 named-provider registry；
  Consequences 第一条就是递归与深度上限。
- [.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md)：
  三个组合控制（persona / toolFilter / maxDepth）的精确语义。"Visibility is not
  authority" 一节值得整段读：toolFilter 是受信同进程的组合行为，不是安全边界——
  真正的 authority 设计需要独立的授权表示与执行期强制点，明确不在这个特性里。
- [docs/architecture.md 的 Capability seams 一节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#capability-seams)：
  "Subagent providers vary just as widely behind one interface, from a fresh child
  agent to a delegated turn in another product"——一个接口后面，传输可以从同进程
  子代理到另一个产品里的一个 turn。
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：**continuable 子代理**（durable 子会话、
followup 逐轮续话、结算通知送达父的收件箱）、**后台委派**（立即返回 job id，通用
job 工具收集）、**委派策略继承**（子的 sandbox 覆盖在委派边界定死、approval 钉在
`'never'`——子代理的审批请求被确定性拒绝而不是等人）、**进程外传输**（ACP /
Codex / Claude Code——真正的权威边界在进程墙上）、以及**结构化输出**
（outputSchema 强制子代理回 JSON）。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 子代理 | subagent | 独立上下文里跑一次受委派任务的子代理；dsh 的 spawn/fork/acp 是不同传输 |
| 委派 | delegation / delegate | 父把自包含任务交给子并等结论；dsh 的模型面工具叫 subagent，本课叫 delegate |
| 一次性委派 | one-shot | 一个任务一个结果，跑完即收；dsh 另有 continuable（可续对话的 durable 子会话） |
| 受限工具集 | toolset / tool filter | 显式白名单；dsh 的 toolFilter 让工具从子的提示与执行一起消失（one visibility） |
| 隔离 | isolation | 上下文（私有日志）、能力（白名单）、可观察性（父日志不内联子事件）三面 |
| 深度上限 | depth limit / maxDepth | 绝对上限：子深度 = 父 + 1，超 cap 在 spawn 之前拒；dsh 默认 3，本课 2 |
| 委派开销 | delegation overhead | 子的事件数/轮次/用过的工具——随结果回喂父的账目 |
| 委派摘要 | delegation summary | 父日志里那次 delegate 的 tool/result：结论 + 开销，不含子的中间事件 |
| 子日志单独可查 | child log by reference | 父不内联子事件；`subagents.logOf(id)` 拿子的完整账本 |
| 继承父上下文 | inheritsParentContext | spawn=false（子看不到父对话）；fork=true（子带父的已完成 turn） |
| 可见性 ≠ 权威 | visibility is not authority | 白名单改的是模型可见视图，不是进程内的授权边界 |
| 白名单 | allowlist | 子的能力清单：显式名单、无默认全量；装配处一行即委派策略 |
