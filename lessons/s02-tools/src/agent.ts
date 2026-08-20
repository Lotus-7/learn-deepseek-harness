import type { ChatMessage, Model } from '@learn-dsh/mock-model'
import type { ToolRegistry } from './registry'
import { executeToolCall, type PipelineHooks } from './pipeline'

export interface RunLoopOptions extends PipelineHooks {
  /** 保险丝：模型连续请求工具的步数上限，默认 20。 */
  maxSteps?: number
}

/**
 * 最小 agent 循环：把用户输入喂给模型；模型要么给出最终回答，
 * 要么请求工具——经守卫管线执行、把结果贴回对话、再问模型，直到得到回答。
 * 工具不再由循环自己 find + execute：名册归 ToolRegistry，执行归管线，
 * 循环只负责「调模型 → 跑管线 → 回喂」的节奏。
 * dsh 对应 packages/core/agent-loop：同一个循环在那里被拆成
 * turn/step 两级，并挂上会话事件与插件扩展点。
 */
export async function runLoop(
  model: Model,
  registry: ToolRegistry,
  userText: string,
  options: RunLoopOptions = {},
): Promise<ChatMessage[]> {
  const maxSteps = options.maxSteps ?? 20
  const messages: ChatMessage[] = [{ role: 'user', content: userText }]
  const schemas = registry.schemas()

  for (let step = 1; step <= maxSteps; step++) {
    const { message, finishReason } = await model(messages, schemas)
    messages.push(message)

    if (finishReason !== 'tool_calls' || !message.tool_calls) {
      return messages
    }
    for (const call of message.tool_calls) {
      const record = await executeToolCall(registry, call, options)
      messages.push({ role: 'tool', content: record.output, tool_call_id: call.id })
    }
  }
  throw new Error(`模型连续 ${maxSteps} 步都在请求工具，超出 maxSteps 上限，循环中止`)
}
