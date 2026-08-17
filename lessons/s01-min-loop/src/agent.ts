import type { ChatMessage, Model, ToolCall } from '@learn-dsh/mock-model'
import type { Tool } from './tools'

export interface RunLoopOptions {
  /** 保险丝：模型连续请求工具的步数上限，默认 20。 */
  maxSteps?: number
}

/**
 * 最小 agent 循环：把用户输入喂给模型；模型要么给出最终回答，
 * 要么请求工具——执行、把结果贴回对话、再问模型，直到得到回答。
 * dsh 对应 packages/core/agent-loop：同一个循环在那里被拆成
 * turn/step 两级，并挂上会话事件与插件扩展点。
 */
export async function runLoop(
  model: Model,
  tools: Tool[],
  userText: string,
  options: RunLoopOptions = {},
): Promise<ChatMessage[]> {
  const maxSteps = options.maxSteps ?? 20
  const messages: ChatMessage[] = [{ role: 'user', content: userText }]
  const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }))

  for (let step = 1; step <= maxSteps; step++) {
    const { message, finishReason } = await model(messages, schemas)
    messages.push(message)

    if (finishReason !== 'tool_calls' || !message.tool_calls) {
      return messages
    }
    for (const call of message.tool_calls) {
      messages.push(await executeCall(tools, call))
    }
  }
  throw new Error(`模型连续 ${maxSteps} 步都在请求工具，超出 maxSteps 上限，循环中止`)
}

async function executeCall(tools: Tool[], call: ToolCall): Promise<ChatMessage> {
  const tool = tools.find((t) => t.name === call.function.name)
  const output = tool
    ? await tool.execute(JSON.parse(call.function.arguments) as Record<string, unknown>)
    : `错误：没有叫 ${call.function.name} 的工具`
  return { role: 'tool', content: output, tool_call_id: call.id }
}
