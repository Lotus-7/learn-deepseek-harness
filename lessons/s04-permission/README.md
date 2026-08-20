# s04 · permission：权限与审批——工具不是想跑就能跑

> 模型说「我要删这个文件」只是请求；能不能跑，由管线里的守卫在执行前裁决——拒绝也要让模型看得见。

## 为什么

s03 的循环已经能干活、能记账，但它有个隐含的假设：**模型请求的工具都应该执行**。
给模型接上 `delete_file`、`run_command` 这类工具的瞬间，这个假设就危险了——模型可能删错文件、
跑错命令，而「模型自己觉得没问题」从来不是安全依据。工具一旦有副作用，执行前就必须有人说了算。

本课给 s02 的执行管线叠上**权限层**，三个设计决定：

1. **三态决策，不是二值开关**。`allow`（放行）/ `deny`（否决）/ `ask`（交给人裁决）。
   大部分系统的权限只有「行/不行」，但真实世界的多数调用落在中间：说不清该不该，
   就该去问人。`ask` 把「不确定」显式化——它不是拖延，是把决定权交还给为此负责的人。
2. **权限长在管线上，不长在工具里**。守卫是 `preExecute` 钩子数组里的一员，在
   `execute` 之前统一把关：一处挂上，名册里所有工具（包括未来注册的）都被罩住。
   若让每个工具自己检查自己的权限，N 个工具就是 N 份检查代码——新工具忘写一份就是裸奔，
   策略换个口味要改 N 处。管线单点还带来一个免费的好处：**策略可整体替换**——
   把守卫换成一个 `{ '*': 'deny' }` 的规则表，整个世界立刻变成只读（本课演示第二幕）。
3. **拒绝是回喂，不是异常**。deny 与「用户拒绝」都以结构化文本落成 `role: 'tool'`
   的结果消息（`权限拒绝：<原因>`），模型看得见、知道为什么、能改道；工具体从头到尾没跑。
   这延续了 s02 的约定（校验失败、守卫否决都不是进程崩溃），也延续 s03 的宪法——
   权限拒绝以 `tool/result` 落会话日志，它是模型可见事实。

```text
  模型请求 delete_file
        │
        ▼
  ① 参数校验（s02）
        ▼
  ② 权限守卫（本课）：规则表（工具名或 '*'）→ allow / deny / ask
        │            │                └─ askUser 回调 ──► 假用户（演示）/ UI（真实产品）
        │            │                                       │
        │            │            allow ◄────────────────────┘
        │            ▼
        │      deny / 用户拒绝 ──► 「权限拒绝：<原因>」作为 tool 结果回喂模型 ──► 模型改道
        ▼
  ③ execute（只有被放行的调用才到这里）
```

### fail-safe：三条「宁可拒绝」的默认

权限层最怕的不是拦得太严，是**漏**。本课把三个「没说清」的场景全部倒向拒绝或交给人：

1. **规则未匹配 → 默认 `ask`**。不是默认 allow（忘配的工具默默放行，等于没有权限层），
   也不是默认 deny（未知工具全挡死，探索性调用全撞墙）。未知交给人是唯一的 fail-safe：
   既不放行，也不替用户做决定。
2. **ask 但没有 `askUser` 回调 → 按 deny 处理**。无头环境（CI、定时任务）里没有用户可问，
   不能猜「用户大概会同意」——没有通道就拒绝。
3. **`askUser` 自己抛错 → 同样按 deny 处理**。审批通道坏了，问题必须失败在关着的一侧，
   而不是把异常漏给工具调用方、更不能失败成放行。

dsh 在这一层是同一个立场（`packages/interaction/user-approval/src/index.ts`）：
默认 policy 是 `'ask'`，没有任何 answerer 时瀑布落到 fail-closed 的 `'unavailable'`，
answerer 抛错或返回词表外的值同样归一成 `'unavailable'`——而非授权结果一律当拒绝处理。

## 跑起来

```sh
pnpm --filter @learn-dsh/s04-permission dev
```

不用任何 API key。剧本：模型先读文件（allow 直通）→ 想调 `delete_file`（危险）→
权限裁决 `ask` → 剧本化假用户拒绝 → 模型收到拒绝文本 → **改用 `move_to_trash` 完成任务**。
预期输出（节选，完整版还有事件流与第二幕）：

```text
[user] 帮我清理 a.txt：先看一眼内容，再把它处理掉
[assistant] 请求工具 read_file
[tool] 工具结果：「a.txt」的内容：项目周会纪要……（共 12 行）
[assistant] 请求工具 delete_file
[tool] 工具结果：守卫否决：权限拒绝：规则 delete_file → ask，用户拒绝了 delete_file 的执行；请改用允许清单内的工具完成目标
[assistant] 请求工具 move_to_trash
[tool] 工具结果：已把 a.txt 移入回收站（可随时恢复）
[assistant] a.txt 已处理：直接删除被用户拒绝，我改用回收站完成清理（可随时恢复）。……

—— 权限决策轨迹 ——
read_file      → 放行（rule）：规则 read_file → allow，直接放行
delete_file    → 否决（ask-denied）：规则 delete_file → ask，用户拒绝了 delete_file 的执行；……
move_to_trash  → 放行（rule）：规则 move_to_trash → allow，直接放行

—— 审批记录 ——
问：delete_file({"path":"a.txt","force":true}) —— delete_file 未获预授权，执行前需要用户确认
答：deny（拒绝这一次）

宪法对拍（模型可见 = 已落日志，权限拒绝也不例外）：4 次模型请求全部等于日志前缀的投影：true

—— 第二幕：deny-all 世界 ——
[assistant] 请求工具 read_file
[tool] 工具结果：守卫否决：权限拒绝：策略把 read_file 标记为 deny；……
[assistant] 这个会话的策略拒绝了所有工具调用（通配 * → deny），我无法读取或修改任何文件。请先放宽策略。
```

本课在 s03 的 src/ 上叠加出一个新文件、动了三个旧文件，建议按这个顺序读：

1. `src/permission.ts` —— 本课主角 `createPermissionGuard`：规则表（工具名或 `'*'`
   通配 → 三态决策，先精确后通配）+ `askUser` 回调注入 + 三条 fail-safe 约定；
   可选 `remember: true` 让同一工具记住首次最终裁决；返回值就是否决原因（放行为
   `undefined`），附带只读 `trace`——每次调用的最终裁决与理由，放行也记。
   决策缓存默认**关着**：逐次裁决对齐 dsh 的 `allowed-once`（见下）。
2. `src/pipeline.ts` —— 只有两行实质改动：`PreExecuteHook` 的返回值允许
   `Promise`，`executeToolCall` 里 `await guard(...)`。审批要等人的回答，守卫
   必须能异步——同步钩子（s03 的 `requireForce`）零修改照常工作。
3. `src/tools.ts` —— 新增 `read_file`（只读，allow 直通的例子）与
   `move_to_trash`（可恢复的清理，「被拒后的安全替代」要有真实的去处才有戏）。
4. `src/index.ts` —— 第一幕剧本 + 决策轨迹 / 审批记录 / 事件流 / 宪法对拍四段回放；
   第二幕换 `{ '*': 'deny' }` 规则表跑同一个请求，展示「换守卫 = 换世界」。
5. s03 带来的 `log.ts` / `agent.ts` / `registry.ts` 原样未动——权限层是管线的
   pre-execute 钩子，不碰日志与循环。

### 一次性授权 vs 会话记忆

`remember` 缺省是 `false`：同一个工具每次 `ask` 都重新问人。dsh 的 `ApprovalOutcome`
里唯一的授权形态叫 **`allowed-once`**——一次授权只覆盖那一次调用，不多不少
（`packages/interaction/user-approval/src/index.ts` 模块注释的原话：
"grants apply only to the requested action"）。会话级记忆省事，但有授权漂移的风险：
用户批准的是「删 a.txt」，记住的却可能是「delete_file 随便用」——下一次删除的
可能是不该删的东西。本课把记忆做成显式开关并默认关闭，就是要让这个取舍被看见。

改两个地方感受一下：

- 在 `src/index.ts` 把第一幕的规则表换成 `{ '*': 'deny' }`（照抄第二幕），
  重跑：`read_file` 第一步就被挡，模型只好空手回答——deny-all 世界里连只读都活不下去，
  这就是「策略可整体替换」的含义；
- 把 `askUser: scriptedUser` 这一行删掉，重跑：模型调 `delete_file` 时收到的不再是
  「用户拒绝」，而是「需要用户审批，但没有可用的审批通道（fail-safe，按拒绝处理）」——
  这就是无头环境里 ask 的归宿，fail-safe 的第二条约定；
- 再把 `remember: true` 加进选项、给剧本的假用户配第二次回答，观察同一工具第二次
  调用不再进审批（决策轨迹里第二条的 `via` 是 `cache`）。

## 看真码（进阶导读）

如果你已经在别的系统里写过工具权限，直接看 dsh 在这一层多做了什么：

- [packages/core/tools/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/index.ts)
  的 `PreToolDecision`：与本课三态**同名同义**的判别联合——`allow` 直跑、
  `deny`（带 reason）落成错误结果、`ask`（可带 reason）等审批。落点在
  `prepareExecution`：`tools/pre-execute` 瀑布（默认 `allow`）给出裁决后，
  `ask` 走 `serviceAsk`、`deny` 直接物化成 `isError` 的 tool 结果
  （文本形如 `Error: <reason>`）回喂模型——**工具体从头到尾不跑**，与本课相同。
  审批服务是**机会式**消费：`ctx.get('approval')` 拿不到（没组装审批插件）就把
  `ask` 降级成 `deny`——本课「没有 askUser 回调就拒绝」的生产版。
- [packages/interaction/user-approval/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/user-approval/src/index.ts)
  的 `ApprovalService`（`ctx.approval`）：审批 seam 的 Service Definition。
  几个值得抄的设计：
  - **闭环结局词表** `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
    （[types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/user-approval/src/types.ts)），
    唯一授权是 `allowed-once`；answerer 抛错、返回词表外的值，一律归一成
    fail-closed 的 `'unavailable'`——异常被 seam 包住，绝不外溢成放行；
  - **审批是审计事件**：`request()` 每问一次，`approval/asked` 与
    `approval/decided` 成对落会话日志，且必须在 turn 内闭合（turn 是 durable
    日志的提交边界，turn 之间裸落的事件重载时无法与崩溃尾巴区分）；
  - **审批策略对模型透明**：会话策略（`ApprovalPolicy = 'ask' | 'never'`，
    `'never'` 是无头 CI 的确定性拒绝）通过 system prompt 的 runtime-context
    快照告知模型，切换策略时 `agent.inject()` 注入一条说明——模型不该在不知情时
    反复请求注定被拒的调用；
  - **会话级策略切换也是事件**：`approval/policy` 落日志、可重放，resume 不需要
    任何追补状态——s03「事实与视图分离」在权限上的应用。
- [packages/interaction/permission-presets/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/permission-presets/src/index.ts)
  的 `PermissionPresetService`（`ctx.permissionPresets`）：用户面上的**预设层**。
  它不发明新的权限模型，而是把两个独立旋钮——sandbox 模式（文件系统能碰哪里）与
  审批策略（ask/never）——打包成命名预设（默认表：`workspace-write` + `ask`、
  `danger-full-access` + `never`），写路径是 `/permission` 命令，读路径是
  `permissions` 会话投影，用户意图落在 `permission/preset` 事件；旋钮组合不匹配
  任何表项时显示为派生态 `custom`。对照本课：`rules` 表是教学版的最小预设，
  dsh 把「策略」拆成了正交旋钮再加一层打包。
- [packages/interaction/tool-ask-user/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/tool-ask-user/src/index.ts)
  的 `ask_user_question` 工具：**模型主动**向用户提问（确认、选择、补信息），
  暂停到 UI provider 返回人的回答，答案作为普通 tool 结果回喂。注意它与审批的方向
  相反：审批是 harness 问用户「**允不允许这次调用**」（模型是被告）；ask-user 是
  模型问用户「**任务该怎么办**」（模型是提问者）。两者共用「答案回喂模型」的机制，
  但决策权完全不同。
- 真实的 answerer 长什么样：[packages/acp/acp/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/src/index.ts)
  监听 `approval/request` 瀑布，把问题转发给 ACP 客户端的
  `requestPermission`（选项只有 `allow-once` / `reject`），并刻意
  「never infers a durable grant from an unknown client response」——
  未知的客户端回应绝不推定出持久授权，与本课默认关闭 `remember` 同一立场。
- [docs/architecture.md 的 Turn flow 一节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#turn-flow)：
  `tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*`
  ——审批政策住在 `tools/pre-execute` 这个通用扩展点上；更细的流程图（pre 瀑布 →
  单调守卫 → `ctx.approval` 一次性审批 → execute）在
  [docs/tool-execution-pipeline.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md)。
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：审批期间用户按了取消怎么办（`AbortSignal`
与 `'cancelled'` 结局，s05）、权限要不要按「沙箱模式」管到文件系统路径粒度
（sandbox 旋钮与 `sandbox_permissions` 提权审批，s10）、预设怎么组装成完整产品
（profile 与 bundle，s14）。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 权限策略 / 规则表 | permission policy / rules | 工具名（或 `'*'`）→ 三态决策 |
| 三态决策 | allow / deny / ask | dsh 的 `PreToolDecision` 同款词表 |
| 审批 | approval | ask 决策交给人裁决的整个过程 |
| 回答者 | answerer | dsh 里监听 `approval/request` 的 UI/客户端 |
| 审批结局 | ApprovalOutcome | dsh 闭环词表；唯一授权是 `allowed-once` |
| 一次性授权 | one-shot grant | 一次授权只覆盖当次调用（dsh 的立场） |
| 会话记忆 | remember / cache | 本课可选：同工具记住首次裁决 |
| fail-safe / fail-closed | fail-safe / fail-closed | 缺省与出错都倒向拒绝，绝不倒向放行 |
| 决策轨迹 | decision trace | 每次调用的最终裁决与理由（放行也记） |
| 权限预设 | permission preset | dsh 打包 sandbox + approval 的用户面开关 |
| 无头 | headless | 无人工在场的运行（CI）；ask 无人可问 → 拒绝 |
