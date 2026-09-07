# s13 · persistence：持久化——恢复、分叉、回放

> 会话的持久化不需要「保存状态」——日志本来就是事件流，把它逐行写进文件，恢复、分叉、回放三项能力全部免费。

## 为什么

s12 的技能与后台工作流都还活在内存里——进程一死，能力没了，会话也没了。要活下去，得回到 s03
立下的那条规矩：**模型可见的对话历史不是存出来的状态，而是从 append-only 事件日志投影出来的视图**。
当时这句话只在内存里成立——进程一死，日志没了，投影没了，会话没了。本课把日志搬到磁盘上，而搬法几乎是
平凡的：每个事件一行 JSON（JSONL），追加即写入。平凡的搬法换来三件不平凡的事，全部来自「状态是投影」
这一个事实：

```text
resume（恢复） = 读文件 → 重放事件 → 重建日志 → 派生历史免费复原
fork  （分叉） = 复制前缀到新文件 → 之后两边独立增长
replay（回放） = 读文件 → 渲染事件 → 人类可读 transcript
```

为什么**天然可回放**？因为系统里不存在第二份需要同步的状态。如果对话历史是直接维护的 messages 数组，
持久化就得回答「数组怎么存、改了怎么落盘、两份怎么不漂移」；而在事件溯源（event sourcing）的形状里，
messages 只是 `deriveMessages(events)` 的函数值——函数是纯的，同一份事件永远投影出同一份历史。
落盘-重放一致性因此可以写成一条硬断言：**文件里的事件逐条等于内存日志的事件，重放出的派生历史与
estimateTokens 全等**（测试钉住）。这就是 s03 地基的兑现时刻。

**写入时机：落账即持久，而不是批缓冲。** 本课的 durable 插件监听 `session/event` 落账广播，
每次同步 write + fsync——`sessions.append()` 返回的那一刻，事件已穿过页缓存到达存储。于是「模型看得见 ⟺
已落账 ⟺ 已落盘」三件事同时成立：崩溃丢事件的窗口是零，断言可以写成「跑完一个 turn 立刻读文件比对」。
dsh 的生产版**不能**这么做：流式对话每秒落几十个 chunk 事件，逐条 fsync 的吞吐撑不住。它的解法是
`PersistenceCoordinator` 的有界批缓冲（`DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200`——事件先进内存队列，
至多 200ms 合并成一次 fsync），`session/flush` 是显式的即时屏障，再由 checkpoint-policy 插件在
**丢不起的位置**主动要屏障：下一个模型请求前、顶层工具可能产生外部副作用前、每个 pre-step 边界——
「崩溃至多丢缓冲窗口内的事件，副作用与请求绝不丢」。这是吞吐与时机的真码取舍；教学版没有吞吐压力，
选最强的时机语义，换来完全确定的测试。

**崩溃语义：turn/end 是提交点。** 进程可能死在任何一行写到一半的地方，读回来必须分流，本课与 dsh 的
两个后端（JSONL 与 SQLite）共享同一条分界线：

| 损坏位置 | 判定 | 处置 |
|---|---|---|
| 最后一个 `turn/end` 之前（**committed 区**） | 已经承诺过的历史坏了 | **拒绝打开**，报行号与期望 seq——宁可不开也不猜 |
| 最后一个 `turn/end` 之后（**崩溃尾巴**） | 进程死在 turn 中途 | 截到最近完整事件 + 响亮警告 |
| 完整事件但 turn 未闭合（`turn/end` 没来得及写） | 半成品 turn | **保留**已写事件，合成收尾关掉它 |

为什么 turn/end 是分界线：它是循环的提交点——落盘之前这个 turn 的所有事件都可能被重写，用户也没拿到
回答；落盘之后这段历史就是「发生过的事实」。**承诺过的坏了要喊，没承诺的半成品可以收拾**。合成收尾
（`interruptedClosers`）收拾两件事：模型请求过的工具调用没有 result（悬空的 tool_calls 会让多数 provider
拒绝整个请求——给每个未配对调用补一条「结果未知」的 tool/result），以及缺失的 `turn/end(aborted)`。
真码的 `interruptedTurnClosers` 同款，且错误文本（TOOL_OUTCOME_UNKNOWN）明确教模型：只读或幂等的操作可
重试，可能有副作用的先核对外部状态——**恢复不是假装崩溃没发生，是把「发生了但不知道结果」如实入账**。

还有一条容易忽略的边界：**resume 恢复的是日志，不是装配**。日志里有「模型调过什么工具」的事实，但
工具名册、技能附加工具、权限的会话记忆都是进程态，重启后回零。dsh 把 `agentPreset`（用什么插件组合跑的）
持久化进会话头，正是为了让 resume 不至于恢复出一段「历史里调过这些工具、现在却没装配它们」的会话；
教学版装配固定，用不到这层，但差距要讲清。同理，权限的 remember 记忆不落盘——重启后首次调用重新走
审批（能力面与权限面分离的又一体现）。

| 本课文件 | 职责 | dsh 对应 |
|---|---|---|
| `persistence.ts` | JSONL 文件层：头行/事件行编码、materialize、append+fsync、scan（坏行分流）、resume（截断+合成收尾落盘）、forkToFile | session-persistence-jsonl（+ coordinator 的修复编排） |
| `plugin-durable.ts` | durable 插件：监听 session/event 同步落盘 | coordinator 的 installWritePath（批缓冲版） |
| `plugin-tools-session.ts` | `seed` 选项：重放构造日志（resume 的入口） | CreateSessionOptions.seed / SessionStore.prepare |
| `transcript.ts` | renderTranscript：事件 → 人类可读行（纯投影） | session-query 的只读面（transcripts derive from the stream） |
| `log.ts` | s03 的日志（本课零改动直接复用：replay/fork 早就在） | core/session 的 Session/SessionStore |

值得点名：s03 的 `SessionLog.replay` 与 `SessionLog.fork` 在内存里早已写好，本课几乎没改 `log.ts`——
持久层只是给它们接上文件。**地基对了，上层是薄的**；这是事件溯源结构自带的杠杆。

## 跑起来

```sh
pnpm --filter @learn-dsh/s13-persistence dev
```

不用任何 API key，四幕（节选）：

```text
—— 第一幕：对话落盘（…/s13-demo-XXXX/main.jsonl）——
  落盘 7 条事件（turn 1：一问、一次 echo、一答），逐事件与内存日志一致——append 返回时已 fsync。

—— 第二幕：进程重启——新实例 resume 同一文件，模型记得暗号 ——
  resume：重放 7 条事件重建日志；turn 从 2 续接，新事件 seq 从 7 续接不重置。
  请求检查：重启后第一次模型请求包含重启前的用户输入（「记住暗号：榴莲酥」）。
  模型回答：暗号是榴莲酥——这是重启前的对话里定的，日志我看得见。

—— 第三幕：fork——支线从第一幕末尾（seq 6）分出，两边独立增长 ——
  支线 …/branch.jsonl：继承 7 条前缀（header：parentSession=main，seedLength=7）。
  fork 后：主线新增 4 条（turn 3，问「几个字」），支线新增 4 条（turn 2，问「翻译成英文」）——互不可见。

—— 第四幕：replay——仅凭文件打印完整 transcript ——
· 主线（main.jsonl）：
  ── turn 1 开始
  用户 ▸ 记住暗号：榴莲酥。先用 echo 把它复述一遍。
  模型 ▸ 请求工具 echo(text=暗号：榴莲酥)
  工具 ▸ echo → 暗号：榴莲酥
  模型 ▸ echo 已确认，暗号记住：榴莲酥。
  ── turn 1 结束（completed）
  …（turn 2、turn 3 依次可见）
· 支线（branch.jsonl）：
  …（前 7 行与主线逐行相同，之后是支线自己的 turn 2）
```

第二幕的「记得」不是剧本演的：演示拿住了 mock 模型的请求记录，硬断言**重启后第一次请求的 messages
里包含重启前的用户输入**——「模型能看到全部历史」由投影机制保证，不靠模型自觉。

本课新增四个文件（persistence / plugin-durable / transcript / persistence.test）、小改一个
（plugin-tools-session 的 seed 选项）、重写演示入口，建议按这个顺序读：

1. `src/persistence.ts` —— 文件层全部：头行词汇（`SessionHeader`：id + fork 谱系
   parentSession/seedLength）、`SessionFile.materialize`（临时文件 + fsync + rename 的原子物化）、
   `append`（write + fsync——「落账即持久」的物理含义）、`scanFile`（坏行分流的完整算法，表格式
   JSDoc 讲清 committed 区/崩溃尾巴的判定）、`interruptedClosers`（合成收尾）、`resumeSession`
   （截断与收尾**必须落盘**，否则残迹永远在场）、`forkSessionFile`（复用 `SessionLog.fork` 的边界
   校验 + 谱系落头）。
2. `src/plugin-durable.ts` —— 十行的 durable 插件：挂点为什么是 `session/event`（对照真码
   installWritePath）、同步 fsync 与批缓冲的取舍（文件头注释整段对照）。
3. `src/plugin-tools-session.ts` —— 只加了一个 `seed` 选项：`SessionLog.replay(seed)` 构造日志，
   对照真码 `CreateSessionOptions.seed`——重放在构造期发生，插件挂载完成的瞬间派生历史已完整在场。
4. `src/transcript.ts` —— `renderTranscript` 纯函数：tool/result 用 tool/call 配对补工具名，
   压缩事件渲染成检查点行；没有一行状态是编出来的。
5. `src/index.ts` —— 四幕装配与硬断言（落盘一致、请求含重启前历史、seq/turn 续接、前缀相同互不
   串线、共享前缀 transcript 逐行相同）。
6. `src/persistence.test.ts` —— 五组断言：落盘-重放一致（逐事件 + 派生历史 + estimateTokens，
   含压缩事件的无损往返）、resume 续接、崩溃残迹分流（半行截断 + 合成收尾落盘、committed 区坏 JSON/
   seq 断裂/版本不认识各自拒绝）、fork 边界（谱系、前缀、互不影响、尾巴不进支线）、临时目录幂等清理。

改两个地方感受一下：

- **手动砍残迹再 resume**：演示跑完后打开收束段打印的 `main.jsonl`，把最后一行删掉一半字符存盘
  （模拟写一半崩溃），然后在 `src/index.ts` 的第二幕前插入两行——`resumeSession(mainPath)` 的结果
  打印 `warnings`——再跑一次：你会看到「崩溃尾巴：丢弃最后 1 行未写完的残迹」与「未闭合 turn：追加
  N 条合成收尾」两条警告，且 transcript 的最后一段以 `turn N 结束（aborted）` 收口。对照
  `persistence.test.ts` 的「最后一行写到一半」用例，那就是这套行为的最小复刻。再把中间某一行改成
  非法 JSON 试试——同样的文件，resume 直接拒绝：**位置决定命运，损坏本身不变，变的是它落在承诺线
  的哪一边**。
- **把 fork 边界挪到另一个 turn/end**：`src/index.ts` 里 `act1End` 是第一幕的 turn/end（seq 6）。
  把 fork 挪到第二幕之后——`const act1End = scanFile(mainPath).events.length - 1`（此时主线已有
  两幕，边界是 turn 2 的 turn/end）——重跑：支线的 seedLength 从 7 变成 11，transcript 里支线
  **带着「暗号是什么」的第二问第二答**去走自己的路；主线第三问与支线翻译问仍然互不可见。再故意把
  边界改成 `act1End - 1`（落在 turn 内部）：fork 直接拒绝「未闭合的 turn」——turn 边界是分叉的
  安全点，半截 turn 不是合法的续写起点。

## 看真码（进阶导读）

dsh 的 durable session 是一个家族（`packages/session/` 下 persistence / projection / titles / telemetry
四族），本课是 persistence 一族的教学投影。导读按「先看契约、再看两个后端、最后看恢复与策略」：

- [packages/session/README.md](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session)
  的家族表：`session-persistence/`（定义 `ctx.sessionPersistence` 与共享写编排）、
  `session-persistence-jsonl/` / `session-persistence-sqlite/`（两个存储后端）、
  `session-checkpoint-policy/`（语义检查点）；projection 一族（`session-projection/`、
  `session-projection-cache/`）把「日志派生状态」也做成了能力——`ProjectionDefinition` 是
  init/apply/view 三个纯函数加 stateVersion，持久化的投影缓存行「never authoritative, only a fold
  shortcut」，版本不匹配整行丢弃重折。本课的 `deriveMessages` 是它的单机零依赖前身。
- [packages/session/session-persistence/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence/src/index.ts)：
  Service Definition 真身。`append` 的契约一句话讲完时机语义："resolves only after durability"；
  `load` 的 JSDoc 是本课坏行分流的逐字出处——"A complete interrupted final turn is preserved and
  durably closed with missing tool errors plus any open step and turn boundaries; only a torn
  final record is discarded. Unknown versions and corruption in the committed prefix reject."
  另注意 `prepare`/`inspect`/`load`/`readFrom` 四个读面的分工（resume 用、观察用、修复用、投影
  缓存续折用）——教学版一个 `scanFile`/`resumeSession` 折叠了它们。
- [packages/session/session-persistence/src/coordinator.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence/src/coordinator.ts)：
  写路径编排。三个与本课直接对话的点：① 写盘挂点同样是 `ctx.on('session/event', …)`（installWritePath）
  ——本课 durable 插件同款挂法，真码多了有界批缓冲（`SessionWriteBehind`）与 `session/flush` 屏障；
  ② 同一会话的操作挂在 per-id promise 链上串行（`serialize`），并发 flush 与 load 永不交错写——教学版
  单线程演示省略了整层并发写；③ 修复的编排：tornMarker 截断 + closers 追加分两步 fsync（`commitRepair`，
  seam 不要求原子），修完**重读**已提交的图而不是把旧内存视图记在新 revision 名下。
- [packages/session/session-persistence-jsonl/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/src/index.ts)：
  JSONL 后端。物化用「临时文件写完 + fsync + `link()` 发布」而不是 rename——link 在目标已存在时失败
  （EEXIST），两个进程并发物化同一 id 谁也覆盖不了谁，rename 会静默顶掉（教学版注释里讲了这段差距）；
  `appendLines` 与本课同款三步 open('a') → write → sync，且部分写失败时把文件回滚到写前大小——否则
  游标不变的重试批次会写出重复 seq。物理编码默认 zstd 分帧（可配 none），读路径按帧恢复撕裂尾巴。
- [packages/session/session-persistence-jsonl/src/format.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/src/format.ts)：
  `SessionLogScanner` 的逐行语义：`finish()` "ignoring a final record without a newline as a torn
  tail"；committed 区的坏行报 `unparsable committed event at line N`、seq 断裂报 `seq gap in
  committed region`——本课 `scanFile` 的错误文案与判定对齐于此。`encodeSegment` 把任意 SessionId
  （未校验的 branded string）编码成安全路径段——路径注入是文件后端必须自带的防线，教学版 id 直接
  取自受控文件名，不需要。
- [packages/session/session-persistence-sqlite/src/schema.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-sqlite/src/schema.ts)：
  SQLite 后端的 schema 层。`SCHEMA_VERSION = 15` 单调递增，只在**表结构**破坏性变化时 bump，与会话
  自己的 `version`（事件词汇表，`SESSION_FORMAT_VERSION`）正交——两把版本尺子量的是不同的东西；
  打开时 `user_version` 不匹配"rejects rather than being migrated in place"（CLAUDE.md 的 pre-release
  立场：后端拒绝旧盘面格式，不做兼容垫片）。`scanRows` 的洞分流与本课同一条线："the first unparsable
  row or seq gap after the last `turn/end` marks a tolerated torn tail; the same hole in the
  committed region rejects"——两个后端、两种介质、同一语义。
- [packages/core/session/src/repair.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/repair.ts)：
  `interruptedTurnClosers` 真身：确定性合成（seq 续接、时间戳复用最后真实事件、Map 插入序保持
  transcript 顺序），未配对调用按「已记录/未记录」分 TOOL_OUTCOME_UNKNOWN 与 TOOL_NOT_STARTED 两种
  错误码，文本教模型「只读或幂等才可重试，有副作用的先核对外部状态或问用户」。教学版收了同一立场的
  简化版（单一「结果未知」文本 + turn/end(aborted)；真码的 TurnEndReasonMap 是 merge-extensible，
  专设了 `interrupted` 变体）。
- [packages/core/session/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/index.ts)
  与 [types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/types.ts)：
  fork 与谱系的真身。`SessionStore.fork(source, boundary?, childSessionId?)` 的边界校验（闭区间、
  OPEN_TURN 拒绝）与本课 `SessionLog.fork`/`forkSessionFile` 同款；`SessionHeader` 的
  parentSession/seedLength 的 JSDoc 一句话讲清谱系为什么要持久："Persisting this boundary lets
  resume and replay distinguish parent history from child work"；types.ts 里 SESSION_FORMAT_VERSION
  的 bump 纪律（"bump exactly when an older runtime could no longer handle a new log with full
  semantic correctness"）值得整段读——它是「什么时候算破坏性变化」的判例法。
- [packages/session/session-checkpoint-policy/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-checkpoint-policy/README.md)：
  语义检查点策略——批缓冲世界里「丢不起的位置」如何被围住：模型请求前、顶层工具副作用前
  （取消落在 flush 上时返回 ABORTED_BEFORE_DISPATCH，工具体根本不进）、pre-step 边界。关键的一句
  承认："Loading a backend without this policy is valid, but a crash may lose events still inside
  the configured batching window"——持久化后端与检查点策略是**两个**插件，吞吐取舍归前者，
  语义安全归后者。教学版逐事件 fsync 把这个问题整个消掉了，也就没有这层可拆。
- [docs/architecture.md 的 Session log 一节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#session-log)：
  "Fork, resume, transcripts, telemetry, and persistence all derive from this stream"——本课四个
  动词共享同一个事件流的架构表述，一句顶一节。
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：**并发写**（per-id 串行链、dispose 时排空缓冲、多进程物化
竞争——link 的 EEXIST 就是为此）、**压缩与目录布局**（zstd 分帧、chunk 打包省 60% 体积、project/
session 两级目录、id 路径注入防御）、**schema 演进**（两把版本尺子、升级步链、migrate-on-continue）、
**投影的持久化缓存**（stateVersion 失配整行丢弃）、以及**会话级元数据的独立服务**（titles、telemetry
都从同一条流派生）。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 事件溯源 | event sourcing | 状态 = fn(事件流)；本课一切能力的来源 |
| JSONL | JSON Lines | 一行一个 JSON；dsh 的 JSONL 后端同款（默认 zstd 分帧编码） |
| 只增不改 | append-only | 日志没有 update/pop；「修改历史」在 JS 层是 TypeError |
| 持久性 | durability | write 返回 = 已达存储（fsync），不是「进了内核缓冲」 |
| 落账即持久 | append-is-durable | 教学版时机语义；真码是批缓冲 + 显式屏障（见下） |
| 批缓冲 | write-behind | 事件先进内存队列、有界窗口（200ms）合并 fsync；dsh 生产版的选择 |
| 屏障 / 检查点 | flush / checkpoint | 批缓冲世界里「现在必须落盘」的显式请求；checkpoint-policy 在副作用前/请求前围栏 |
| 恢复 | resume | 读文件 → 重放事件重建日志 → 继续对话；seq 与 turn 续接不重置 |
| 重放 | replay | ① 仅凭事件重建状态；② 渲染人类可读 transcript（本课两个意思都在场） |
| 分叉 | fork | 复制边界前前缀到新文件；parentSession/seedLength 记谱系 |
| 谱系 | lineage | parentSession（母会话）+ seedLength（继承条数）：区分父母历史与本支工作 |
| 会话头 | session header | 日志外的不可回放元数据（id、createdAt、谱系、agentPreset）；JSONL 第一行 |
| 撕裂尾巴 | torn tail | 写到一半的残迹；截到最近完整事件 + 警告 |
| 提交区 | committed region | 最后一个 turn/end 之前的事件；坏了拒绝打开 |
| 合成收尾 | synthetic closers | 为未闭合 turn 补 tool/result + turn/end；dsh 的 interruptedTurnClosers |
| 格式版本 | format version | 事件词汇表版本（SESSION_FORMAT_VERSION）与表结构版本（SQLite SCHEMA_VERSION）两把尺子；不认识就拒绝 |
| 物化 | materialize | 会话第一次落盘（临时文件 + fsync + 原子发布）；之前不占文件 |
