/** 模型可见的一条消息。s01 只用到 user/assistant/tool 三个角色，system 留给后续课程。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

/** 模型发起的一次工具调用；arguments 是 JSON 字符串（与主流 LLM API 一致）。 */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** 注册时提供给模型的工具描述（JSON Schema 形态）。 */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 一次模型响应：给出的消息 + 为什么结束这次生成。 */
export interface ModelResponse {
  message: ChatMessage
  finishReason: 'stop' | 'tool_calls'
}

/** 模型适配器。dsh 里对应挂在 ctx.llm 后面的 provider；每课可替换实现。 */
export type Model = (messages: ChatMessage[], tools: ToolSchema[]) => Promise<ModelResponse>
