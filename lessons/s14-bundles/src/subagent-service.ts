import type { SessionLog } from './log'
import type { Tool } from './tools'

/**
 * 子代理能力的 Service Definition：请求、结果、句柄与错误词汇——一个 seam 的第一角色。
 *
 * 本模块**只有词汇**：类型、类型化错误、Provider 接口与 `subagents` 服务键的目录声明。
 * 它不 import 任何 provider（subagent-provider.ts 实现它），也不 import 任何 Consumer
 * （subagent-tools.ts 的 delegate 工具）——契约站在中间，两边各自靠过来。
 *
 * dsh 的同构是三包（见 packages/subagent/README.md 的家族表）：
 *
 * | 角色 | 本课文件 | dsh 对应（subagent seam） |
 * |---|---|---|
 * | Service Definition | 本文件：`SubagentProvider`/`SubagentRun` 等词汇 + `subagents` 键 | packages/subagent/subagent（SubagentRuntime + types.ts） |
 * | Service Provider | subagent-provider.ts（in-process spawn） | packages/subagent/subagent-spawn-in-process（+ 共享 driver subagent-in-process-driver） |
 * | Consumer | subagent-tools.ts 的 delegate 工具 | packages/subagent/tool-subagent（模型面的 `subagent` 工具） |
 *
 * 教学版的**收窄**（README「看真码」细讲差距）：dsh 的 SubagentRuntime 是 named-provider
 * registry——spawn / fork / ACP / Codex / Claude Code 多种传输按名共存，调用方点名选用
 * （"a named-provider registry … mirroring the LLM adapter registry, not the
 * single-service bash executor"，capability-seam 决策笔记）；本课只有 in-process 一种
 * 传输，注册表退化为装配一行（subagent-plugin.ts），多 provider 共存留给真码。
 */

/**
 * 委派深度的失败码。契约的一部分：Consumer（delegate 工具）与模型据码分支、
 * 补补救语，不解析错误文本——与 s09 FsError / s10 WorldError 同款立场。
 * dsh 对应 resolveChildDepth 抛出的 SubagentDepthError（packages/subagent/subagent/
 * src/child-agent.ts）：拒绝发生在子代理**启动之前**，没有发布任何子会话。
 */
export type SubagentErrorCode = 'SUBAGENT_DEPTH_EXCEEDED'

/**
 * 类型化的子代理错误：message 面向人（捕获后进入模型可见的回喂文本），
 * code 面向程序。
 */
export class SubagentError extends Error {
  /** 稳定失败码：见 {@link SubagentErrorCode}。 */
  readonly code: SubagentErrorCode

  constructor(message: string, code: SubagentErrorCode) {
    super(message)
    this.name = 'SubagentError'
    this.code = code
  }
}

/**
 * spawn 一次子代理的请求。核心两个字段（README 的主线）：`task` 与 `toolset`——
 * 委派 = 一段自包含任务 + 一份**显式**的工具白名单。
 *
 * - `toolset` 是 Tool 对象数组（委托方从自己的名册里挑好的**同一批工具实现**——
 *   工具体闭包绑定它的装配容器，子代理经它照常解析服务（比如 fs 工具落到父的
 *   执行世界）。dsh 同款语义：toolFilter 过滤的是 deployment-global 名册的**可见性**，
 *   不是复制一套实现（"a scoped restriction filters globals"，composition-controls
 *   决策笔记）。
 * - **没有默认工具集**：不传就是空数组（子代理只能对话，调不了任何工具）。
 *   「默认全量」是把父的全部权力复制给每个子代理——委派本该缩小爆炸半径；
 *   默认值在这里是隐藏的越权面，所以 Definition 不设。
 * - `depth` 是**委派者**的深度（顶层 0）；provider 算 childDepth = depth + 1 并与
 *   `maxDepth` 比较。dsh 对应：delegationDepthOf(agent) 读父深度，子深度 = 父 + 1
 *   （packages/subagent/subagent/src/depth.ts）；教学版工具没有执行上下文携带
 *   代理身份，深度由 delegate 工具的克隆链显式携带（见 subagent-tools.ts）。
 * - `maxDepth` 是**绝对**上限：childDepth 超过它即拒。省略表示不设上限——直接
 *   调用 spawn 的程序方自担；模型面永远经 delegate 工具，它必传（默认 2）。
 *   dsh：直接 SubagentStartRequest 可省略，tool-subagent 的 config 默认 3
 *   （"a small finite default that still permits a root plus three descendant
 *   generations"，composition-controls 决策笔记）。
 */
export interface SubagentSpawnRequest {
  /** 交给子代理的自包含任务文本：子看不到父的对话，任务里要带全上下文。 */
  readonly task: string
  /** 子代理的工具白名单：显式传入的 Tool 对象（同一批实现，受限的只是名册）。 */
  readonly toolset: readonly Tool[]
  /** 委派者深度：顶层代理为 0（默认）；delegate 克隆链逐层 +1。 */
  readonly depth?: number
  /** 绝对深度上限：子的深度（depth + 1）超过它即拒（SUBAGENT_DEPTH_EXCEEDED）。 */
  readonly maxDepth?: number
  /** 委派者的取消 signal：父被取消，子的循环收口 aborted（s05 语义照旧）。 */
  readonly signal?: AbortSignal
}

/**
 * 子代理的结构化结果：父侧拿到的全部东西。
 * `answer` 是结论；其余字段是**委派开销的账目**——它们让父（和使用方）能观察
 * 「这次委派花了多少」而不用读子的完整日志。
 * dsh 对应 SubagentResult（packages/subagent/subagent/src/types.ts）：那里是
 * `{ output, structured?, stopReason }`——output 用 finalAssistantOutput 从子日志选
 * 「最后一条非空 assistant 消息」；stopReason 映射子 turn 的结束方式
 * （completed/aborted/error/…），非 completed 时 output 可能不完整。教学版的
 * toolsUsed/eventCount/turns 是教学加料（真仓这些数字属于遥测，不进结果契约）。
 */
export interface SubagentOutcome {
  /** 子代理的最终回答：子派生历史里最后一条非空 assistant 消息；没有则为空串。 */
  readonly answer: string
  /** 子的 turn 结束方式（completed/aborted/error）：非 completed 时 answer 可能不完整。 */
  readonly stopReason: 'completed' | 'aborted' | 'error'
  /** 子实际调用过的工具名（按首次出现去重）。 */
  readonly toolsUsed: readonly string[]
  /** 子私有日志的事件总数——委派开销的度量。 */
  readonly eventCount: number
  /** 子跑的 turn 数（一次 spawn 一个任务，通常为 1）。 */
  readonly turns: number
}

/**
 * Provider 产出的「正在跑的子代理」：result 只 resolve 不 reject——子层的失败
 * （模型错、保险丝熔断）落进 `stopReason: 'error'`，由 Consumer 决定怎么回喂；
 * 只有 seam 表达不了的基础设施故障才 reject（dsh 同款："Does NOT reject on a
 * child-level failure … Rejects on an infrastructure fault"，types.ts 的
 * SubagentRun.result）。`log` 是子的私有日志：父日志不含它，要看得**单独来查**
 * ——隔离的可观察面。
 */
export interface SubagentRun {
  /** 子的结构化结果；随子循环收口 resolve。 */
  readonly result: Promise<SubagentOutcome>
  /** 子的私有事件日志（与父日志互不可见）。 */
  readonly log: SessionLog
  /** 卸载子的整个装配（逆序回滚它的全部插件——s07 的效果清单在子身上的回响）。 */
  dispose(): void
}

/**
 * 服务层返回的句柄：run + 会话内编号。编号归服务所有（它要据此回答 logOf）；
 * dsh 的 SubagentRun.id 是 provider 铸造的持久 SessionId，教学版用自增字符串。
 */
export interface SubagentHandle extends SubagentRun {
  /** 本次委派的会话内编号（sub-1、sub-2…）。 */
  readonly id: string
}

/**
 * 子代理传输的 Provider 接口：把一次请求落成一个跑起来的子代理。
 * dsh 对应 SubagentProvider.start（types.ts）——那里的 start 是 async 且「fulfillment
 * is the single publication and ownership-transfer boundary」；教学版同步组装即可
 * 返回（in-process 没有发布窗口要等）。
 */
export interface SubagentProvider {
  /** provider 名（诊断与演示输出用）。 */
  readonly name: string
  /**
   * 启动一个子代理：组装子的私有装配并驱动它的循环。
   * @param request - 见 {@link SubagentSpawnRequest}。
   * @returns 已在跑的子代理 run。
   * @throws SubagentError 深度超限（子代理根本不启动，零副作用）。
   */
  spawn(request: SubagentSpawnRequest): SubagentRun
}

/**
 * `subagents` 服务的公开面：spawn 一次委派 + 按编号查子日志。
 * dsh 对应 ctx.subagents（SubagentRuntime）：那里还有 named-provider 注册表、
 * continuable 子代理的 startContinuable/followup 与 listChildren——教学版收窄到
 * one-shot 委派与子日志可查两件事。
 */
export interface SubagentService {
  /**
   * 启动一个子代理（工具集、深度上限都由请求显式携带）。
   * @param request - 见 {@link SubagentSpawnRequest}。
   * @returns 已在跑的子代理句柄（带会话内编号）；await handle.result 拿结构化结果。
   * @throws SubagentError 深度超限；TypeError maxDepth 不是非负安全整数。
   */
  spawn(request: SubagentSpawnRequest): SubagentHandle
  /**
   * 按编号取子代理的私有日志——「子日志单独可查」的服务面：父日志不内联子的
   * 事件，审计与演示从这里拿完整账本。
   * @param id - spawn 返回的句柄编号。
   * @returns 该子代理的日志。
   * @throws 没有这个编号的子代理（列出现存的）。
   */
  logOf(id: string): SessionLog
}

// 服务目录扩展：给迷你 ServiceMap 加 'subagents' 键。键与类型归 Definition 所有
// （与 'fs'/'world' 同款）；subagent-plugin.ts 贡献实例，Consumer 按键消费。
declare module './cordis.js' {
  interface ServiceMap {
    /** 子代理能力：spawn 委派 + 子日志查询（由 subagent-plugin 贡献）。 */
    subagents: SubagentService
  }
}

/**
 * 校验深度上限：非负安全整数，负数/分数/负零/非整数都拒——校验归 seam 而不是
 * 只靠某一个模型面入口（"Every public entry validates the domain rather than
 * relying on one model-facing configuration path"，composition-controls 决策笔记）。
 * dsh 对应 assertSubagentMaxDepth（packages/subagent/subagent/src/depth.ts）。
 * @param maxDepth - 待校验的上限值。
 * @throws TypeError 不是非负安全整数。
 */
export function assertMaxDepth(maxDepth: unknown): void {
  if (
    typeof maxDepth !== 'number'
    || !Number.isSafeInteger(maxDepth)
    || maxDepth < 0
    || Object.is(maxDepth, -0)
  ) {
    throw new TypeError(`子代理深度上限必须是非负安全整数，收到 ${String(maxDepth)}`)
  }
}
