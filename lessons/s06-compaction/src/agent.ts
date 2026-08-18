import type { ChatMessage, Model, ModelResponse } from '@learn-dsh/mock-model'
import type { ToolRegistry } from './registry'
import { executeToolCall, type PipelineHooks } from './pipeline'
import { SessionLog, type TurnEndReason } from './log'
import { maybeCompact, type CompactionOptions } from './compaction'

export interface RunLoopOptions extends PipelineHooks {
  /** 保险丝：模型连续请求工具的步数上限，默认 20。 */
  maxSteps?: number
  /** 会话日志：传入则在其上续写（多轮对话、fork 之后），不传则新建一个。 */
  log?: SessionLog
  /**
   * 本次 turn 的取消 signal（s05）：调模型前与每次工具执行前都检查；
   * 触发后循环收口为 turn/end(aborted) 并正常返回「截至取消的派生历史」。
   * 调用方因此拿到一份闭合的日志——可以打印、可以 fork、可以在下一个 turn
   * 换一个新 signal 继续。dsh 对应 Agent.cancel(cause)：取消的粒度是 turn
   * （packages/core/agent-loop/src/agent.ts 在 turn 之间换新的 AbortController）。
   */
  signal?: AbortSignal
  /**
   * 压缩策略（s06）：传入则每个步骤边界（上一步结果落账后、下一次模型请求
   * 发出前）评估预算，派生历史超阈值就把头部换成一条 session/compacted 事件
   * （见 src/compaction.ts）。不传则完全关闭压缩——s05 及以前的行为。
   * dsh 里这件事不归循环管：compaction-basic 插件监听 agent/pre-step 瀑布做
   * step pressure 触发（packages/compaction/compaction-basic/src/index.ts），
   * 教学版还没有插件系统，先用显式参数注入——s07/s08 会把它变成真正的插件。
   */
  compaction?: CompactionOptions
}

/**
 * 最小 agent 循环：把用户输入喂给模型；模型要么给出最终回答，
 * 要么请求工具——经守卫管线执行、把结果贴回对话、再问模型，直到得到回答。
 * s03 起循环不再自己维护 messages 数组：每个事实先落 SessionLog，
 * 下一次模型请求的输入由 log.deriveMessages() 从日志投影——
 * 「模型可见 = 已落日志」，循环里不存在绕过日志直达模型的路径。
 * 返回值也是投影（log.deriveMessages()），不是另一份状态。
 *
 * s05 起两类事故有不同的归宿，**按层级分流**：
 * - 工具层错误（execute 抛错、校验失败、守卫否决）是对话的一部分——
 *   以 tool/result 回喂模型，模型看见、改道，循环继续（可恢复）；
 * - 模型/适配器层错误（网络、鉴权、剧本耗尽）是进程级事件——
 *   收口 turn/end(error) 后原样上抛，由调用方决定进程的命运（致命）；
 * - 取消（signal 触发）不是错误——收口 turn/end(aborted) 后正常返回，
 *   「停止」也是一次有账可查的收口（干净收尾是可恢复的前提）。
 *
 * s06 起循环多了个预算检查点：options.compaction 传入时，每个步骤边界
 * 先评估派生历史的估算 token，超阈值就把头部换成一条 session/compacted
 * 事件再发请求——日志依旧 append-only，模型看到的是压缩后的投影。
 *
 * 三条出口都写 turn/end，日志永远是闭合的；唯一的例外是 maxSteps 保险丝
 * （s01 以来的语义）：异常中止留下未闭合的 turn，审计与 fork 都能看出
 * 这段历史不完整。
 * dsh 对应 packages/core/agent-loop/src/agent.ts 的 turn()：abort 与 error
 * 在 catch 里各自给出 TurnEndReason，finally 无条件补写 turn/end——
 * 无论哪条路径，durable 日志都以闭合的 turn 收尾。
 * @param model - 模型适配器（mock 或真实现）。
 * @param registry - 工具名册。
 * @param userText - 本轮的用户输入。
 * @param options - 保险丝、管线钩子、会话日志、取消 signal、压缩策略。
 * @returns 整段对话的派生历史：正常完成时最后一条是最终回答；
 * 取消时是截至取消的事实（没有最终回答）。
 * @throws 模型/适配器层错误（收口 turn/end(error) 后原样上抛）；
 * maxSteps 耗尽（不写 turn/end，留下未闭合的 turn）。
 */
export async function runLoop(
  model: Model,
  registry: ToolRegistry,
  userText: string,
  options: RunLoopOptions = {},
): Promise<ChatMessage[]> {
  const maxSteps = options.maxSteps ?? 20
  const log = options.log ?? new SessionLog()
  const signal = options.signal
  const schemas = registry.schemas()
  const turn = log.nextTurn()
  /** 本 turn 是否已写 turn/end：三条出口至多收口一次，异常竞态也不写双份。 */
  let ended = false
  const endTurn = (reason: TurnEndReason): ChatMessage[] => {
    ended = true
    log.append({ type: 'turn/end', turn, reason })
    return log.deriveMessages()
  }

  log.append({ type: 'turn/start', turn })
  log.append({ type: 'user/message', content: userText })

  try {
    for (let step = 1; step <= maxSteps; step++) {
      // 取消检查点 ①：步骤边界。mock 模型不真支持中断，教学版把检查点断在
      // 「上一步工具结果落账之后、下一次模型请求发出之前」——真适配器应把
      // signal 传进请求（dsh 的 agent/pre-step 瀑布与 prompt 组装都携带 signal）。
      signal?.throwIfAborted()

      // 压缩检查点（s06）：同一步骤边界上评估预算——超阈值就把头部消息换成
      // 一条 session/compacted 事件，紧接着的 deriveMessages() 自然投影出
      // 「summary + 尾部窗口」。压缩在模型请求发出之前完成，模型永远看到
      // 压缩后的历史；每步至多压一次，压不动的场景见 maybeCompact 的注释。
      if (options.compaction !== undefined) await maybeCompact(log, options.compaction)

      let response: ModelResponse
      try {
        response = await model(log.deriveMessages(), schemas)
      } catch (error) {
        // 致命：模型/适配器层抛错。收口后原样上抛——调用方 catch 到的异常
        // 与日志里的 turn/end(error) 讲的是同一件事。
        endTurn('error')
        throw error
      }
      log.append({ type: 'assistant/message', message: response.message })

      if (response.finishReason !== 'tool_calls' || !response.message.tool_calls) {
        return endTurn('completed')
      }
      for (const call of response.message.tool_calls) {
        log.append({
          type: 'tool/call',
          turn,
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })
        // 取消检查点 ② 在管线入口（executeToolCall 开头的 throwIfAborted），
        // 检查点 ③ 在工具体自己手里（监听 signal 的工具才能被中途打断）。
        // 取消时 executeToolCall 上抛，tool/result 不落账——下面的 append 不执行。
        const record = await executeToolCall(registry, call, options, signal)
        log.append({ type: 'tool/result', callId: call.id, output: record.output })
      }
    }
    // 不写 turn/end：异常中止留下未闭合的 turn，审计与 fork 都能看出这段历史不完整。
    throw new Error(`模型连续 ${maxSteps} 步都在请求工具，超出 maxSteps 上限，循环中止`)
  } catch (error) {
    // 取消：不是错误，是第三条出口。检查 ended 是为了与「模型层 error 收口后
    // 恰好 signal 也触发」的竞态错开——先定的结局不改写。
    if (signal?.aborted && !ended) return endTurn('aborted')
    throw error
  }
}
