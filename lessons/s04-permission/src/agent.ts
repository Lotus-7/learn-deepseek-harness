import type { ChatMessage, Model } from '@learn-dsh/mock-model'
import type { ToolRegistry } from './registry'
import { executeToolCall, type PipelineHooks } from './pipeline'
import { SessionLog } from './log'

export interface RunLoopOptions extends PipelineHooks {
  /** 保险丝：模型连续请求工具的步数上限，默认 20。 */
  maxSteps?: number
  /** 会话日志：传入则在其上续写（多轮对话、fork 之后），不传则新建一个。 */
  log?: SessionLog
}

/**
 * 最小 agent 循环：把用户输入喂给模型；模型要么给出最终回答，
 * 要么请求工具——经守卫管线执行、把结果贴回对话、再问模型，直到得到回答。
 * s03 起循环不再自己维护 messages 数组：每个事实先落 SessionLog，
 * 下一次模型请求的输入由 log.deriveMessages() 从日志投影——
 * 「模型可见 = 已落日志」，循环里不存在绕过日志直达模型的路径。
 * 返回值也是投影（log.deriveMessages()），不是另一份状态。
 * dsh 对应 packages/core/agent-loop 的 agent.ts：每个 turn/step 写 turn/*、
 * step/* 事件，请求输入取 this.session.deriveMessages()。
 * @param model - 模型适配器（mock 或真实现）。
 * @param registry - 工具名册。
 * @param userText - 本轮的用户输入。
 * @param options - 保险丝、管线钩子、会话日志。
 * @returns 整段对话的派生历史，最后一条是最终回答。
 */
export async function runLoop(
  model: Model,
  registry: ToolRegistry,
  userText: string,
  options: RunLoopOptions = {},
): Promise<ChatMessage[]> {
  const maxSteps = options.maxSteps ?? 20
  const log = options.log ?? new SessionLog()
  const schemas = registry.schemas()
  const turn = log.nextTurn()

  log.append({ type: 'turn/start', turn })
  log.append({ type: 'user/message', content: userText })

  for (let step = 1; step <= maxSteps; step++) {
    const { message, finishReason } = await model(log.deriveMessages(), schemas)
    log.append({ type: 'assistant/message', message })

    if (finishReason !== 'tool_calls' || !message.tool_calls) {
      log.append({ type: 'turn/end', turn, reason: 'completed' })
      return log.deriveMessages()
    }
    for (const call of message.tool_calls) {
      log.append({
        type: 'tool/call',
        turn,
        callId: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })
      const record = await executeToolCall(registry, call, options)
      log.append({ type: 'tool/result', callId: call.id, output: record.output })
    }
  }
  // 不写 turn/end：异常中止留下未闭合的 turn，审计与 fork 都能看出这段历史不完整。
  throw new Error(`模型连续 ${maxSteps} 步都在请求工具，超出 maxSteps 上限，循环中止`)
}
