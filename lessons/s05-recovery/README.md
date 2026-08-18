# s05 · recovery：取消、错误恢复与 turn 生命周期

> 循环跑起来之后，只有一种结局是「干完」；用户会按停止、上游会 500、网络会断。问题从来不是「怎么不出事」，而是出了事之后——**账本还在不在，会话还能不能继续**。

## 为什么

s04 的循环能干活、能记账、有权限，但它有个隐含假设：**跑起来就会跑完**。
真实产品里这个假设撑不过第一天：用户要在半途按 Esc，工具要挂 60 秒，
上游服务要返回 500。本课给循环补上三种「不正常」的结局，三个设计决定：

1. **turn 是有生命周期的：start → 若干 step → end(reason)**。s03 把 turn 立为
   durable 日志的提交边界，s04 又靠它守住「审批必须在 turn 内闭合」。本课把
   边界的另一头补全：turn/end 的 **reason 是「结束方式」的陈述**——
   `completed`（模型给出回答）、`aborted`（外部取消）、`error`（模型层致命错误）。
   reason 联合是可扩展的：s03 只有一支，本课扩到三支，将来还会更多
   （dsh 有六支，见看真码）。消费端按 reason 分支，而不是拿「有没有 turn/end」猜。
2. **错误按层级分流**。判据只有一个问题：**这个错误模型自己能处理吗？**
   能——工具 `execute` 抛错、参数校验失败、守卫否决——都是对话的一部分，
   错误文本作为 `tool/result` 回喂，模型看见、改道、继续（**可恢复**；
   s04 已有雏形，本课补齐测试与叙事）；不能——模型/适配器层抛错
   （网络、鉴权、剧本耗尽）——模型坏了没法告诉模型，这是**进程级事件**：
   收口 `turn/end(error)` 后把异常原样上抛，由调用方决定进程的命运（**致命**）。
   同一个 `throw new Error(...)`，在工具层是台词，在适配器层是事故。
3. **取消是协作的，收尾是干净的**。JavaScript 砍不断正在跑的同进程代码——
   `AbortSignal` 是「请求停止」的广播，工具体**监听**它才有中断点。
   signal 从 `runLoop` 一路贯穿：步骤边界检查 → 管线入口检查 → 工具体自己
   监听。其中步骤边界是教学简化：mock 模型不支持真中断，检查点断在
   「上一步结果落账后、下一次请求发出前」；真适配器会把 signal 传进请求本身。
   触发后循环**收口 `turn/end(aborted)` 再退出**——取消不是 kill -9，
   把「停止」也当成一次有账可查的收口。

```text
  turn/start ── user/message
       │
       ▼  ┌── 步骤循环 ────────────────────────────────────────┐
  [检查点①] signal？ ──已触发──► turn/end(aborted) ──► 返回派生历史
       │  未触发
       ▼
    模型调用 ──抛错──► turn/end(error) ──► 异常上抛（致命：调用方处理）
       │  正常
       ├── 给出回答 ──► turn/end(completed) ──► 返回（最后一条是回答）
       └── 请求工具
            [检查点②] 管线入口 signal？──已触发──► 同 aborted
            [检查点③] 工具体监听 signal（挂起任务才能被打断）
            execute 抛错 ──► 「工具执行出错：<原因>」作为 tool/result 回喂 ──► 继续（可恢复）
```

### 为什么干净收尾是可恢复的前提

s03 已经埋下伏笔：**fork 拒绝未闭合的 turn**——半截历史不是合法的续写起点。
如果取消只是抛异常走人，日志就停在 `tool/call` 后面悬空：fork 不敢用、
审计看不出「是干完了还是断气了」、下一轮对话接不上。本课的测试把这个闭环
钉死：取消收口后的日志 `fork()` 正常出支线、能带着新 signal 继续下一 turn
（`recovery.test.ts`「取消收口后日志是闭合的」一条）——被取消的会话不是废墟，
是**一段闭合的历史**。dsh 的立场更彻底：turn 的 catch 算出 aborted/error 的
reason，**finally 无条件补写 turn/end**（见看真码）——任何路径都不许裸奔出 turn。

## 跑起来

```sh
pnpm --filter @learn-dsh/s05-recovery dev
```

不用任何 API key，三幕剧本（完整输出还含每幕的 turn 生命周期事件流）：

```text
—— 第一幕：会挂起的工具被超时取消 ——
[user] 全盘扫描一下工作区
[assistant] 请求工具 slow_scan

turn 1 start
  user/message 全盘扫描一下工作区
  step：模型请求工具 slow_scan
  tool/call slow_scan({"scope":"整个工作区"})
turn 1 end（reason: aborted）
日志收口：turn/end reason=aborted，事件总数 5

—— 第二幕：抛错的工具被模型看到并绕开 ——
[assistant] 请求工具 fetch_stats
[tool] 工具结果：工具执行出错：上游统计服务返回 500，暂时不可用
[assistant] 请求工具 cached_stats
[tool] 工具结果：缓存统计：本周构建 12 次，成功率 91.7%，平均耗时 3 分 40 秒
[assistant] 实时统计服务 500 了，但我拿到了缓存：……换个数据源就行。
turn 1 end（reason: completed）

—— 第三幕：模型层致命错误 ——
循环上抛：DeepSeek API 连接失败（模拟网络事故）
turn 1 start
  user/message 随便干点什么
turn 1 end（reason: error）

三幕结局对照：aborted / completed / error——同一个循环，三种有账可查的收场
```

第一幕的「外部」是 `AbortController` + 40ms 闹钟——真产品里这一头是 Esc、
关窗口、父代理收回委派。本课在 s04 的 src/ 上重写了两个文件（循环与演示）、
扩了三个文件的签名，建议按这个顺序读：

1. `src/agent.ts` —— 本课主角 `runLoop` 的重构：`endTurn(reason)` 收口函数
   （三条出口共用，`ended` 标志保证至多一条 turn/end）；三个取消检查点；
   模型调用的 try/catch 分流出 error 出口；外层 catch 里「取消不是错误」。
2. `src/pipeline.ts` —— `executeToolCall` 多了 `signal` 参数：入口
   `throwIfAborted()`，执行时传给工具体；catch 里**取消优先于错误回喂**——
   signal 已触发时上抛（循环都要停了，回喂一个不会再被调用的模型没有意义）。
3. `src/tools.ts` —— `Tool.execute` 签名扩展为 `(args, signal?)`：可选参数，
   s04 的旧工具零修改照常工作。看 `slowScanTool`：**AbortSignal 友好**的工具体
   长什么样——60 秒的定时器 + `abort` 监听里 `clearTimeout` 再以取消原因
   reject（不留悬挂定时器）；以及 `fetchStatsTool`（execute 抛错）与
   `cachedStatsTool`（安全替代）这对搭档。
4. `src/log.ts` —— 只动了类型：`TurnEndReason = 'completed' | 'aborted' | 'error'`，
   s03 的 turn/end reason 联合在这里第一次扩展。
5. `src/index.ts` —— 三幕剧本 + `printLifecycle`（打印 turn 生命周期事件）；
   s04 的权限守卫照常在场（复制前进：能力只增不减）。

改两个地方感受一下：

- 把 `src/tools.ts` 里 slow_scan 的 `60_000` 改成 `20`（工具跑得比 40ms 闹钟快），
  重跑第一幕：`turn 1 end（reason: completed）`，工具结果照常落账——取消是一场
  竞态，谁先落定谁算，signal 触发时循环早已干完；
- 把 `src/index.ts` 第一幕 `controller.abort(new Error(...))` 的参数删掉
  （无参 `abort()`），重跑：工具 reject 的 reason 变成 DOMException，但
  turn/end(aborted) 照旧——取消原因是给人/审计看的，收口协议不依赖它的内容；
- 把第二幕 `fetch_stats` 的抛错从工具体挪到模型适配器（照抄第三幕
  `brokenModel` 的写法），重跑：同一个 `throw`，在工具层是回喂的台词，在模型层
  是 `turn/end(error)` + 上抛的事故——**层级决定归宿**，这是本课最想留下的直觉。

## 看真码（进阶导读）

如果你已经在别的系统里写过取消或重试，直接看 dsh 在这一层多做了什么：

- [packages/core/agent/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/index.ts)
  的 `AgentHandle`：`agent` + `dispose()`。dispose 是一份**能力（capability）**：
  注释原话「among consumers, only the holder can tear this agent down」——
  它依次 stops the loop、awaits its exit、unregisters the agent、removes its
  session、unwinds its scoped world。对照本课：教学版的「调用方」握着一切，
  dsh 把「谁有权停」本身做成了类型——handle 只发给创建它的 owner，
  结构性 owner（provider 卸载）走内部 teardown。
- [packages/core/agent/src/runtime-types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/runtime-types.ts)
  的 `Agent.cancel(cause, options?)`：cause 是 `AgentCancelCause`——
  `user | parent | hook | disposed`（定义在
  [packages/core/session/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/types.ts)），
  **取消必须给出理由**，理由一路写进 turn/end。两个值得抄的细节：默认清空
  inbox（`keepInbox` 才保留待办）；「Waking input submitted after active
  cancellation is queued for the next turn」——取消期间到来的新输入不丢，
  排进下一个 turn。
- [packages/core/agent-loop/src/agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts)
  的 `turn()`：本课 `runLoop` 的生产级同构。catch 里 `signal.aborted` →
  `turnEnds = { kind: 'aborted', reason }` 后仍然 throw（原始异常在驱动器边界
  `kick()` 的 catch 里被 contain——教学版的调用者就是驱动器主人，所以改为
  正常返回）；否则错误**结构化**（`LlmError` 保真，其余压成 `errorChain` 文本）
  后给出 `{ kind: 'error', ... }` 再 emit `agent/error` 上抛；**finally 无条件
  `session.append('turn/end')`**——本课 `endTurn` 的三处出口在 dsh 是一个
  finally。还有一个教学版没有的事实：turn 结束后 `phase.abort = new
  AbortController()`——**取消的粒度是 turn**，被取消的 agent 换新 signal
  就能继续下一 turn。
- [packages/core/agent/src/inbox.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/inbox.ts)
  的 `Inbox`：agent 的两条待办列表 `next-turn` / `next-step`。
  [architecture.md 的 Turn flow](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#turn-flow)
  一句话说清分类：「Some messages wake it immediately; injected context waits
  in the inbox until another message does」——`followup`/`steer` 是唤醒型
  （立即开 turn / 下一步生效），`inject` 是注入型（躺到下一个唤醒到来）。
  `claim()` 是步边界领取；`clear()` 取消待办时落 `outcome: 'canceled'` 的
  splice 事件——**被取消的输入自己也是事件**，这正是
  [consumed-work.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/consumed-work.ts)
  能区分「干了没干完」与「压根没跑」的原因（`accountsForClaim`：aborted /
  error / blocked / interrupted 都算「交代了领取的输入」，唯独 completed 不算）。
- `agent/turn-stopping`：turn 闭合前的最后一个插件机会。turn() 里
  `await this.dispatch.serial('agent/turn-stopping', ...)`——**serial 事件**
  （按序 await、没有 `next()`，对照 waterfall 的 pre-step）；
  [packages/core/agent/src/dispatch.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/dispatch.ts)
  是这套 agent-scoped 分发器的实现。插件在这里做「turn 停止前」的收尾——
  本课把收尾焊死在循环里，dsh 把它开成了扩展点。
- [packages/core/session/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/types.ts)
  的 `TurnEndReasonMap`：本课三支联合的完全体——**merge-extensible interface**，
  内建六支（completed / aborted〔带取消原因〕/ blocked / error〔带 `LlmFailure`〕/
  max-tokens / interrupted〔持久化后端关闭崩溃孤儿 turn，loop 从不发它〕），
  插件用声明合并加变体。消费端的姿势看 consumed-work 的 default 分支注释：
  「an unnameable ending over consumed input must not read as success」——
  可扩展联合的未知变体必须按失败处理，绝不能默认成功。
- [packages/core/tools/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/index.ts)
  的工具取消：`execute(args, exec)`——signal 在 `exec` 里随调用下发（本课的
  `(args, signal)` 是同一件事的最小版）；工具可声明协作式 `timeoutMs` 预算
  （由 `dsh-tool-call-timeout-policy` 实施，声明它即断言工具转发 signal——
  本课第一幕的「AbortController + setTimeout」就是手写的 timeout policy）。
  JSDoc 原话钉死了协作式立场：「the registry … cannot hard-kill same-process code」。
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：对话太长把窗口塞满怎么办（s06
compaction）、取消后的待办输入怎么续跑成新 turn（inbox 的完整生命周期）、
错误要不要按 provider 分类重试（llm seam 的适配器契约）。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 取消 / 中止 | cancel / abort | dsh 的 `Agent.cancel(cause)`；cause 分 user/parent/hook/disposed |
| 取消信号 | AbortSignal / AbortController | Web 标准；`reason` 携带取消原因 |
| 协作式取消 | cooperative cancellation | 同进程代码不能硬杀；工具体监听 signal 才有中断点 |
| 检查点 | cancellation point | 本课三处：步骤边界 / 管线入口 / 工具体 |
| turn 生命周期 | turn lifecycle | start → 若干 step → end(reason) |
| 结束原因 | TurnEndReason / TurnEndReasonMap | dsh 的可扩展联合；教学版三支 |
| 干净收尾 | close the turn | 写 turn/end 再退出；未闭合的 turn 不可 fork |
| 可恢复错误 | recoverable error | 工具层：错误文本回喂模型，循环继续 |
| 致命错误 | fatal error | 模型/适配器层：收口 turn/end(error) 后上抛 |
| 句柄 | AgentHandle | dsh：agent + dispose()；持有者才有权拆 |
| 收件箱 | inbox | next-turn / next-step 两条待办列表 |
| 唤醒 / 注入 | wake / inject | followup/steer 立即唤醒；inject 等下一个唤醒 |
| 串行事件 | serial event | `agent/turn-stopping`：按序 await、无 `next()` |
| 崩溃孤儿 | crash-orphaned turn | dsh 的 interrupted：重载时由持久化后端闭合 |
