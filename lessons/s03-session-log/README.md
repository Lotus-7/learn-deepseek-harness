# s03 · session-log：append-only 事件日志是模型的记忆与真理之源

> 对话历史不是存出来的状态，是从一串只增不改的事件投影出来的视图；模型看到什么，日志说了算。

## 为什么

s02 的循环已经能让模型做事，但对话历史是一个内存里的 messages 数组——进程的私有状态。
三个问题随之而来：

1. **记忆与进程同寿命**。进程一重启，对话没了；想恢复、想审计，无处下手。
2. **「模型看到了什么」说不清**。数组在循环里随手 push，没有任何一处能证明第 N 次请求时
   模型看到的确切内容——出了问题只能猜。
3. **没有「另一个未来」**。想在某个节点探索不同走向（重试、对比、子代理），数组只有一条尾巴，
   改了就回不去。

本课把「发生的事实」与「模型的视图」拆开：事实落进 **`SessionLog`**——append-only 的事件
序列，每个事件有单调递增的 `seq`、深冻结、只增不改；视图由 **`deriveMessages()`** 每次从
日志投影。这一拆同时解决了三件事：

- **重放即重建**：不需要另存一份对话状态，事件列表本身就是完整历史——`SessionLog.replay(events)`
  从零重建出等价的日志（s13 持久化的地基）；
- **审计**：每个事实只记录一次、顺序确定、不可篡改，「模型当时为什么这么答」可以逐事件追；
- **分叉**：任意 turn 结束处的前缀都是一份合法历史，`fork(boundary)` 复制前缀另起炉灶，
  两个世界互不干扰。

```text
  用户输入 ──► turn/start ──► user/message ─┐          ┌──► assistant/message
                                             ▼          │ （含 tool_calls）
                       SessionLog（append-only，seq 连续，深冻结）
                       turn/* · user/message · assistant/message
                       tool/call · tool/result               │
                                       ▲                    ▼ deriveMessages()（投影）
                                       │              ChatMessage[]
        工具结果 ──► tool/result ◄── 模型 ◄───────────────────┘
```

### 「模型可见 = 已落日志」是宪法

整个 harness 有一条宪法级约定：**任何到达模型请求的内容，必须能从会话日志重建**
（dsh 文档原话 "Model-visible means logged"）。为什么提到这个高度：

- 如果存在一条「模型看得到、日志里没有」的消息，那么 resume、fork、回放、telemetry 每个
  消费者都会重建出一份**缺了东西**的历史——而且各自缺得不一样，静默漂移，无从对账；
- 所以规则变成：新的模型可见输入 = 新的会话事件，**先落盘，再投影**；循环里不存在绕过
  日志直达模型的路径；
- 宪法不能只靠自觉。本课用对拍把它变成机器检验：mock 模型记录每次请求的 `calls` 快照，
  断言**每一次请求 === 截至该次调用前的日志前缀投影**（`agent.test.ts` 的
  「模型可见 = 已落日志」用例）。谁绕过日志私喂模型，测试当场报警。

## 跑起来

```sh
pnpm --filter @learn-dsh/s03-session-log dev
```

不用任何 API key，剧本与 s02 相同（坏参数 → 校验错误 → 修正 → 守卫否决 → 补 force → 回答），
但这次循环里没有 messages 数组——每个事实先落日志，模型请求由投影给出。预期输出：

```text
[user] 帮我算 2 + 3，然后删掉 a.txt
[assistant] 请求工具 add
[tool] 工具结果：参数校验失败：参数 a 应为 integer，实际是 string（"两"）
[assistant] 请求工具 add
[tool] 工具结果：5
[assistant] 请求工具 delete_file
[tool] 工具结果：守卫否决：delete_file 需要 force: true 才能执行，请确认后带上该参数重试
[assistant] 请求工具 delete_file
[tool] 工具结果：已删除 a.txt
[assistant] 2 + 3 = 5，a.txt 已删除。参数不合规、被守卫拦下都不是事故：错误文本会回到我这里，修正后重试即可。

—— 会话事件流（append-only 真理之源） ——
#0 turn/start         turn=1
#1 user/message       帮我算 2 + 3，然后删掉 a.txt
#2 assistant/message  请求工具 add（callId: call_1）
#3 tool/call          add({"a":"两","b":3})
#4 tool/result        → call_1：参数校验失败：参数 a 应为 integer，实际是 string（"两"）
#5 assistant/message  请求工具 add（callId: call_2）
#6 tool/call          add({"a":2,"b":3})
#7 tool/result        → call_2：5
#8 assistant/message  请求工具 delete_file（callId: call_3）
#9 tool/call          delete_file({"path":"a.txt"})
#10 tool/result        → call_3：守卫否决：delete_file 需要 force: true 才能执行，请确认后带上该参数重试
#11 assistant/message  请求工具 delete_file（callId: call_4）
#12 tool/call          delete_file({"path":"a.txt","force":true})
#13 tool/result        → call_4：已删除 a.txt
#14 assistant/message  2 + 3 = 5，a.txt 已删除。参数不合规、被守卫拦下都不是事故：错误文本会回到我这里，修正后重试即可。
#15 turn/end           turn=1 reason=completed

—— replay 重建 ——
重放 16 个事件重建派生历史，与运行时一致：true
宪法对拍（模型可见 = 已落日志）：5 次模型请求全部等于日志前缀的投影：true

—— fork 分叉 ——
母会话共 16 个事件；在末尾（turn 已闭合）分出两条支线
支线 A（续写「不用了，就这样收尾吧」）→ 好的。a.txt 已删除，任务收尾。
支线 B（续写「等等，再帮我算 7 + 8」）→ 先调 add，得到工具结果「15」后回答：7 + 8 = 15。
浅历史复制：支线与母日志共享同一批冻结事件对象：true
母会话不受分叉影响：仍是 16 个事件，最后一条回答仍是「2 + 3 = 5，a.txt 已删…」
```

本课在 s02 的 src/ 上叠加出一个新文件、改造两个文件，建议按这个顺序读：

1. `src/log.ts` —— 本课主角 `SessionLog`：`SessionEvent` 六事件判别联合（构造时不含
   `seq`，落日志时赋予）；`append()` 深冻结入列（`seq = 当前日志长度`，连续契约）；
   `events` 只读快照（改任何历史位置都抛 TypeError，先前取到的快照不随 append 增长）；
   `deriveMessages()` 只投影产消息的三类事件；`nextTurn()` 从日志派生而非内存计数；
   `fork(boundary)` 取闭区间前缀做**浅历史复制**（子母共享冻结事件对象，不可变性让共享
   免费），边界落在未闭合 turn 内时拒绝；`replay()` 仅凭事件列表重建、校验 seq 连续。
2. `src/agent.ts` —— `runLoop` 的改造只有几行：删掉 messages 数组，每个事实先
   `log.append(...)`，模型请求输入取 `log.deriveMessages()`；返回值也是投影，不是另一份
   状态。异常中止（maxSteps）不写 `turn/end`，日志留下未闭合的 turn——审计可见。
3. `src/index.ts` —— 三段演示：事件流打印、replay 对拍（含宪法对拍）、fork 两条支线
   走向不同续写。注意 fork 后支线各自续写，母日志纹丝不动。
4. s02 带来的 `registry.ts` / `pipeline.ts` / `tools.ts` 原样未动——日志层不碰工具层。

### 事件粒度：本课与 dsh 的对应

| 本课事件 | 载荷 | dsh 对应 | 差异 |
|---|---|---|---|
| `turn/start` | turn | `turn/start` | 同名同位；dsh 的 turn 编号由 invariant 跟踪 |
| `turn/end` | turn, reason | `turn/end` | dsh 的 reason 是可扩展联合（completed/aborted/error/blocked…） |
| `user/message` | content | `user/message` | dsh 是带 `source` 的完整 UserMessage（人输入/注入上下文/续轮） |
| `assistant/message` | 整条消息（含 tool_calls） | `assistant/message` | dsh 另落 `assistant/chunk` 逐块保真，并用 `sourceEventSeqs` 引用 |
| `tool/call` | turn, callId, name, arguments | `tool/call` | 同名；dsh 携带 turn/step；arguments 都是未解析的原始 JSON 串 |
| `tool/result` | callId, output | `tool/result` | dsh 携带结构化 message + error + meta |

dsh 还有 `step/start`、`step/end`（本课的「步」隐含在 assistant/message 序列里，s05 引入
turn 生命周期时补全）与 `request/header` 等记录性事件；投影语义与 dsh 的
`SurfaceEventType` 完全一致：只有 user/message、assistant/message、tool/result 三类产消息。

改两个地方感受一下：

- 在 `src/agent.ts` 把模型调用改成偷偷塞一条不在日志里的消息：
  `await model([...log.deriveMessages(), { role: 'user', content: '（未落日志的私聊）' }], schemas)`，
  重跑演示：宪法对拍那行从 true 变 false——模型看得到、日志里没有，机器检验当场抓住。
  这就是「宪法不能只靠自觉」的意思；
- 在 `src/log.ts` 的 `deriveMessages()` 里把 `tool/result` 的投影改成
  `content: '（已隐藏）'`，重跑：事件流一字未变（事实没动），但模型的输入与后续行为全变，
  而宪法对拍仍是 true（投影与请求同源）。日志是事实，投影是策略——两者分开，才谈得上
  「换个投影规则 = 换个产品形态」（s06 压缩课的伏笔）。

## 看真码（进阶导读）

如果你已经理解 event sourcing，直接看 dsh 在这一层多做了什么：

- [packages/core/session/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/types.ts)
  的 `SessionEventMap`：**声明合并（declaration merging）**的事件词汇表——插件往 map 里合并
  新事件类型，`SessionEvent` 判别联合随之扩展，`switch (event.type)` 依旧收窄。每个事件
  envelope 是 `{ type, seq, time, data }`；产消息的事件额外携带 `surfaceOp`（如何进入有序
  表面）与 `sourceEventSeqs`（引用哪些更早的事件）。`ignorable?: true` 标记实现
  **required-on-read**：读不懂且没有该标记的事件必须拒绝重建整个会话，而不是静默跳过——
  本课 `replay()` 对 seq 断裂「宁可拒绝也不重排」是同一哲学的极简版；
- [packages/core/session/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/index.ts)
  的 `Session`：`append(type, data, ...)` 落日志时强制 `seq = log.length` 连续契约、深冻结、
  非 lossless-JSON 数据当场拒绝（坏事件失败在写入处，而不是之后的落盘处）；
  `deriveMessages()` 沿表面投影并按节点增量缓存（本课每次全量遍历）；
  `SessionStore.fork(source, boundary?, childSessionId?)` 与本课同款语义——边界闭区间、
  落在 open turn 内拒绝（`OPEN_TURN`）——并把血统写进 header（`parentSession`、
  `seedLength`），让 resume 与 replay 能区分母历史与子会话自己的工作；
- [packages/core/session/src/surface.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/surface.ts)
  的 `deriveEventMessage`：与本课 `deriveMessages()` 相同的三类型投影规则。dsh 在日志之上
  多一层「有序表面」：压缩等改写历史的操作以 `replace` 节点进入表面（引用并遮蔽被替换的
  节点），日志本身依旧 append-only——「改写」也是事件；
- [packages/core/session/src/invariant.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/invariant.ts)：
  把「seq 严格递增、turn/step 嵌套配对、tool/result 必须有同 step 的 tool/call 在先」做成
  运行时不变量——合法日志的形状不只是文档约定，是会被断言的；
- [packages/core/session/src/known-event-types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/known-event-types.ts)：
  脚本生成的全仓事件词汇表（四十余种：`compaction/*`、`approval/*`、`todo/write`…），
  配合 `ignorable` 构成持久化读路径的 required-on-read 检查；
- [docs/architecture.md 的 Session log 一节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#session-log)：
  原文一段话值得背下来——会话日志是模型所见上下文之源，`deriveMessages()` 从它投影模型
  历史，raw `assistant/chunk` 保真重放与 UI，fork、resume、transcript、telemetry、
  persistence 全部从这条流派生；**"Model-visible means logged."**
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：历史太长怎么压缩（surface replace 与 compaction，
s06）、日志怎么落盘与跨进程 resume（durable 持久化，s13）、子代理要不要自己的私有日志
（subagent 的 seed 血统，s11）。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 会话日志 | session log | dsh 里是 `Session`（经 `ctx.sessions` 创建） |
| 事件 | event | 判别联合；seq 单调、深冻结 |
| 只增不改 | append-only | 修改历史无 API，改冻结对象抛 TypeError |
| 投影 / 派生 | derive / projection | `deriveMessages()`：日志 → 模型可见消息 |
| 重放 | replay | 仅凭事件列表重建日志 |
| 分叉 | fork | 前缀即新历史；dsh 记录 parentSession/seedLength |
| 边界 | boundary | 闭区间 seq；落在未闭合 turn 内被拒绝 |
| 表面 | surface | dsh 的有序消息视图；replace 节点支持压缩改写 |
| 序号 | seq | `seq = 日志长度`，连续性契约 |
| 宪法 | model-visible means logged | 模型可见 = 已落日志；dsh 用运行时不变量断言 |
