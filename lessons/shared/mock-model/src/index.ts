import type { ChatMessage, Model, ModelResponse, ToolCall } from './types'

export * from './types'

export interface MockModel extends Model {
  /** 每次请求收到的 messages 快照，供测试断言模型到底看到了什么。 */
  readonly calls: ChatMessage[][]
}

/** 构造一个 function 调用，参数自动 JSON 序列化。写课程剧本用。 */
export function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/**
 * 创建回放剧本的模型：按顺序吐出 script 里的每个响应，并记录每次请求。
 * 剧本耗尽后抛错而不是静默重复——测试挂掉时应指向剧本缺陷本身。
 */
export function createMockModel(script: ModelResponse[]): MockModel {
  const calls: ChatMessage[][] = []
  let cursor = 0
  const model = (messages: ChatMessage[]): Promise<ModelResponse> => {
    calls.push(structuredClone(messages))
    if (cursor >= script.length) {
      return Promise.reject(
        new Error(`mock 模型剧本已耗尽（共 ${script.length} 条），第 ${cursor + 1} 次调用无响应可回放`),
      )
    }
    return Promise.resolve(script[cursor++]!)
  }
  return Object.assign(model, { calls }) as MockModel
}
