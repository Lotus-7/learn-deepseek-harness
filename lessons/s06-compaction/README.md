# s06 · compaction：上下文压缩——在有限窗口里干无限的活

> 模型的窗口是硬约束，任务是无限的。硬截断丢掉的是事件；压缩丢掉的只是视图——账本上一个字都不少。

## 为什么

s05 的循环能干活、能记账、能从三种结局里干净收场，但它有个沉默的上限：
派生历史只增不减，工具往返越多窗口越满——而上下文的大头从来不是用户输入，
是工具输出（演示里一条 `search_logs` 结果的估算 token 抵得上十几条人话）。
窗口塞满之后只有两条路：**丢历史**（把最老的消息删掉，假装没发生过）或者
**压历史**（把最老的消息压成摘要，事实保留、原文退位）。本课选后者，三个设计决定：

1. **压缩本身是事件，日志依旧 append-only**。压缩不是「把日志改短」——被压掉的
   user/message、tool/result 一个都没删，循环只是追加一条 `session/compacted`
   事件，声明「派生历史的前 N 条让位给这段摘要」。派生规则（`deriveMessages`）
   遇到它就把已投影的前 N 条消息原地换成一条 summary，尾部窗口照常投影。
   为什么必须走事件日志：**可审计**（压了多少条、省了多少 token 落在账上，
   演示收束一幕就是拿日志前缀重放出「压缩那一刻模型看到的历史」）、**可回放**
   （`SessionLog.replay` 只凭事件列表重建出同样的压缩视图）、**可分叉**
   （在压缩点之前 fork 的支线派生出未压缩的完整历史——丢历史的世界里没有这条路，
   删掉的事件找不回来）。丢历史与压历史的区别就在这里：**一个是账本残缺，
   一个是视图变短**。
2. **摘要器是注入的，策略是 harness 的**。`maybeCompact` 只负责「什么时候压
   （阈值）、压哪些（头部 + 尾部窗口）、账怎么记（session/compacted）」；
   把头部压成一段文本的 `summarize` 是可注入函数——演示与测试用确定性摘要器
   （机械保留要点首行与数字事实，同样输入恒定输出），真模型课把它换成一次
   真实的 LLM 调用，压缩器一行不改。摘要的**框架**（前言 + `<compacted-summary>`
   标签对）不属于摘要器而属于 harness：无论摘要质量如何，模型收到的永远是
   「这是既定背景，别复述、直接继续」的检查点，而不是一段身份不明的裸文本。
   token 预算同样是教学近似：`estimateTokens` 中文按字、英文按词、每条消息加
   固定开销——真产品的口径来自 tokenizer 或 provider 上报用量（dsh 把它做成
   独立的 token-meter 服务，压缩器只消费测量结果）。
3. **触发在步骤边界，语义讲清楚**。压缩检查点与取消检查点 ① 同位：上一步
   工具结果落账后、下一次模型请求发出前——模型永远看到压缩后的历史。
   **每个边界至多压一次**：压完仍超阈值不当场连压（摘要调用不便宜，而且
   「压完还超」往往说明尾部本身就太肥，连压救不了），下一个边界自然再评。
   于是把阈值调到极小会看到**多级压缩**：第二级摘要的头部包含第一级摘要——
   摘要的摘要。两类放弃不落事件：头部为空（整个历史都是尾部，没有可压对象）、
   摘要压不过被压内容（压缩必须真的变小才有意义）。

```text
  步骤边界（每次模型请求前）
       │
       ▼
  estimateTokens(派生历史) > threshold ？
       │否                          │是
       ▼                            ▼
  直接发请求              定切点：尾部窗口 keepTail 条
                                    │（切点落在 tool 消息上 → 左移，
                                    │  不拆 assistant(tool_calls)/tool 配对）
                                    ▼
                          summarize(头部) → 前言 + <compacted-summary> 框架
                                    │
                          摘要比头部小？──否──► 放弃（不落事件）
                                    │是
                                    ▼
                          追加 session/compacted 事件（日志只增不改）
                                    ▼
                    deriveMessages() = summary(user) + 尾部窗口 → 发请求
```

摘要为什么是 **user 消息**而不是 system：派生历史按位置投影，摘要出现在压缩点
所在的位置——system 语义上是全局指令，插在对话中段名不副实，OpenAI 风格的 API
里中段 system 本就是非常规用法；dsh 的替换节点同样是 user/message（它的
compaction/summary 事件只落日志，表面替换由紧随其后的 user/message 完成）。

## 跑起来

```sh
pnpm --filter @learn-dsh/s06-compaction dev
```

不用任何 API key，三幕 + 收束（完整输出还含每幕的请求明细与事件流，此处节选）：

```text
—— 第一幕：多轮工具往返把预算推过阈值 ——
第一幕结束：派生历史 6 条，估算 565 / 700 token（未到阈值，本幕没有压缩）

—— 第二幕：超阈值触发压缩 ——
压缩事件落账：压掉头部 5 条，估算 818 → 449 token（阈值 700）
派生历史：9 条 → 5 条。摘要内容：
以下是本会话更早内容的自动摘要。把它当作既定背景，……
<compacted-summary>
早期对话共 5 条消息的摘要。
数字事实：47。
1. 用户：我们的生产集群一共 47 台节点，最近超时报警很多。……
2. 助手调用工具 search_logs
3. 工具结果：检索 "timeout" 命中 24 行：
……
</compacted-summary>
—— 47 台节点的原文已不在模型输入里，只剩摘要里的数字事实

—— 第三幕：压缩后，模型仍引用早期事实 ——
第三幕模型的完整输入（7 条，估算 521 token）：
[user] 以下是本会话更早内容的自动摘要。……
[assistant] 两种模式各命中 24 行。……
……
[user] 顺便确认一下：我们的集群一共多少台节点来着？
模型的回答：我们的集群一共 47 台节点——这个数字来自开场的背景摘要，原文早已被压缩掉，但事实还在。

—— 收束：丢的是视图，不是历史 ——
  session/compacted：压掉 5 条头部消息，估算 818 → 449 token
日志共 22 个事件（user/message 事件 3 个，一个都没删）；当前派生历史 8 条
重放整份日志重建派生历史：8 条，与原日志一致 = true
从压缩前最后一个 turn/end（seq=9）fork：支线派生历史 6 条——分叉自压缩前的世界，看到的是未压缩的完整历史
```

剧本里埋了一个早期事实：第一幕的用户消息说「集群一共 47 台节点」，第二幕压缩
把它压进摘要，第三幕模型在**只有摘要、没有原文**的输入里答出 47。s04 权限层与
s05 恢复层照常在场（复制前进：能力只增不减）。本课新增一个文件、动了两个文件，
建议按这个顺序读：

1. `src/compaction.ts` —— 本课主角：`estimateTokens`/`estimateTextTokens`
   （教学近似的预算口径）、`maybeCompact`（阈值触发 → 配对安全切点 → 注入式
   摘要 → 框架 → 落事件，两条放弃路径）、`deterministicSummarize`（确定性
   摘要器，要点首行 + 数字事实）。
2. `src/log.ts` —— 只动了两处：`SessionEvent` 联合新增 `session/compacted`
   分支（summary + shadowedCount + tokens 前后对照）；`deriveMessages` 遇到它
   就把**已投影的前 shadowedCount 条**原地换成一条 summary（user 形态）。
   注意替换粒度是消息条数而不是「清空到压缩点」——尾部窗口的消息产自更早的
   事件，按事件清空会把尾部一起丢掉。
3. `src/agent.ts` —— 循环只加了两行：步骤边界上 `maybeCompact`，紧接着的
   `deriveMessages()` 自然投影出压缩后的历史。
4. `src/tools.ts` —— 新增 `searchLogsTool`：每次返回 24 行日志的检索工具，
   把预算推过阈值的「燃料」，输出确定性的所以演示可复现。
5. `src/index.ts` —— 三幕剧本 + 收束：压缩前后规模对照（用日志前缀重放审计）、
   模型压缩后的真实输入、fork 出未压缩世界线。

改两个地方感受一下：

- 把 `src/index.ts` 里 `compaction.threshold` 从 700 改成 120：压缩提前到第一幕
  就开始尝试，turn 2 里连续两个边界各压一次——第二级摘要的头部包含第一级摘要
  （摘要的摘要，多级压缩）；头部只剩一两条小消息时压缩放弃（摘要压不过头部），
  极小阈值下循环自然触底而不是无限连压；
- 把 `src/compaction.ts` 里 `deterministicSummarize` 换成你自己的实现（比如
  只保留数字、或干脆返回整段拼接原文），重跑：摘要质量直接决定压缩后模型的
  表现——这是「策略归 harness、摘要归模型」的边界实验，压缩器对此一无所知。

## 看真码（进阶导读）

如果你已经在别的系统里做过上下文管理，直接看 dsh 在这一层多做了什么：

- [packages/compaction/compaction/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction/src/index.ts)
  的 `CompactionEngine`：Compaction 能力的 Service Definition（`ctx.compaction`）。
  三个抽象方法对应三种入口：`compactIfNeeded`（自动策略）、`compactNow`
  （手动命令，`ManualCompactionError` 把失败分成 busy/cancelled/changed/
  summary/commit/persistence 六类）、`compactRegion`（强制压指定区间）。
  本课的 `maybeCompact` 是它的教学投影——seam 的角色划分见
  [packages/compaction/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/README.md)：
  seam + 摘要后端 + 免模型修剪 + 人类命令四个包，各自可换。
- [packages/compaction/compaction/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction/src/types.ts)
  的 `compaction/*` 事件：用声明合并挂进 SessionEventMap 的四类 log-only 事件
  ——`compaction/start`（落锁）、`compaction/summary`（摘要 + 被压区间 +
  shadowedSeqs + 这次摘要调用的 provider/model/usage——「哪个模型写的这份摘要」
  在日志里有永久答案）、`compaction/end`（解锁，失败也记）、`compaction/prune`
  （免模型修剪的影子价格）。真正的表面替换由紧随 `compaction/summary` 的
  `user/message` 事件携带 `surfaceOp: { op: 'replace', start, end }` 显式完成
  （[packages/core/session/src/surface.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/surface.ts)），
  邻接性是契约（影子价格紧贴在替换之前）。教学版把这套三段加锁的事务折叠成
  一个事件、把表面替换折叠进派生规则——单线程循环不需要锁，方向一致：
  **替换历史的操作必须自己也是日志事实**。
- [packages/compaction/compaction-basic/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/index.ts)
  的 `BasicCompactionEngine`：默认 Provider（`static inject = ['llm', 'tokenMeter', 'sessions']`）。
  触发策略两条：`agent/pre-step` 瀑布上的 **step pressure**（步间压力，本课同位）
  与 `agent/request-error` 上的 **context-overflow**（provider 确认窗口超限后
  强制压缩并返回 `{ kind: 'retry' }` 重发请求，教学版没有这条恢复路径）。
  `summarize()` 是它唯一的子类定制钩子——「Override this sole hook for a
  template or remote summarizer」，与本课的注入式 `Summarize` 同一个边界。
- [packages/compaction/compaction-basic/src/config.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/config.ts)
  的默认策略：`thresholdRatio` 0.8（窗口的 80% 触发）、`retainRatio` 0.16
  （保留尾部 16%）、`maxTokens` 8192、`compactionRetries` 1、`maxOverflowRetries` 1，
  还支持按 provider/model 精确覆盖（modelPolicies）。注意阈值是**比例 × 模型
  窗口**换算的 token 预算，不是本课的字符近似；retainTokens ≥ thresholdTokens
  在装配时直接报错——尾部窗口必须真的小于阈值，压缩才有意义。
- [packages/compaction/compaction-basic/src/region.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/region.ts)
  的 `selectCompactableRange` + `compactSurfaceRegion`：选区从头部锚定、按
  token 预算保留尾部、绝不在 tool-call/result 配对中间下刀（安全切点由
  [packages/compaction/compaction/src/tool-pairing.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction/src/tool-pairing.ts)
  的未闭合 tool-call 计数保证，本课的单条左移规则是它的特例）；事务先落
  `compaction/start` 锁再异步摘要，摘要回来还要通过稳定性检查（区间没被并发
  改写）与「summary is not smaller than the shadowed content」的收缩校验
  （教学版把它降级为放弃不落事件）。
- [packages/compaction/compaction-basic/src/summarizer.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/summarizer.ts)
  的 `summarizeWithLlm`：真模型版的注入实现。两个值得抄的细节：摘要请求
  **复用会话自己的 system 与工具表作为前缀**，使这次辅助调用命中 provider 的
  KV 缓存（摘要指令作为最后一条 user 消息追加）；摘要被 `<compacted-summary>`
  标签对包裹、配一段「当作既定背景，不要复述」的前言——本课的框架与它同名
  同用途，且下一轮摘要指令明确要求「已有的摘要块是上一代检查点：合并、不要
  逐字复制」——多级压缩的收敛策略写在指令里。
- [packages/compaction/compaction-tool-result-pruner/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-tool-result-pruner/src/index.ts)
  的 `ToolResultPruner`（`ctx.toolResultPruner`，可选服务）：**免模型**的
  细粒度手段——不摘要、不让位，把超长 tool 结果的中段替换为
  head + `[... tool result middle pruned ...]` + tail（默认 thresholdChars
  8192 / head 4096 / tail 1024，按 Unicode 码点计），每次替换前先落
  `compaction/prune` 影子价格事件。它是压缩的前置减负步骤：先把最肥的工具
  输出修掉，再决定要不要动用摘要。日志类工具输出（本课 search_logs 的 24 行）
  正是它的靶子。
- [packages/compaction/command-compact/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/command-compact/src/index.ts)
  的 `/compact`：人类命令 Consumer——`ctx.compaction.compactNow(...)`，把
  ManualCompactionError 的六类失败翻译成给人看的错误文案。Consumer 不知道
  后端是谁：命令、压缩后端、修剪器全部通过 seam 组合。
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：窗口真的超限了怎么在请求失败后恢复
（context-overflow 重试）、压缩期间的并发写入怎么加锁（compaction/start 的
durable 锁与稳定性检查）、插件系统怎么让压缩不进循环代码（s07/s08 的
agent/pre-step 瀑布）。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 上下文压缩 | compaction | 把旧历史压成摘要以释放窗口；区别于删除 |
| 预算 / 估算 token | token budget / estimate | 教学近似：中文按字、英文按词；dsh 用 token-meter 服务 |
| 阈值 | threshold | 超过即触发；dsh 是 thresholdRatio × 窗口 |
| 尾部窗口 | retained tail / keepTail | 原样保留的最近 N 条（dsh 按 token 预算保留） |
| 摘要器 | summarizer | 注入式；dsh 的唯一子类钩子，默认走 LLM 一次性调用 |
| 检查点 | checkpoint | 落账的摘要消息；框架 + `<compacted-summary>` 标签 |
| 影子价格 | shadow price | dsh 的 compaction/prune 事件：被替换内容的 token 计价 |
| 表面 / 替换 | surface / replace | dsh 的 surfaceOp replace：显式替换一段表面节点 |
| 配对平衡 | tool-pairing balance | 切点不拆 assistant(tool_calls)/tool 配对 |
| 压力触发 | pressure trigger | 步间预算检查（agent/pre-step）；教学版的步骤边界 |
| 窗口超限恢复 | context-overflow recovery | dsh：provider 确认超限后强制压缩再重试 |
| 多级压缩 | multi-level compaction | 摘要的摘要；头部含上一代检查点 |
| 免模型修剪 | model-free pruning | tool-result-pruner：截中段，不调模型 |
