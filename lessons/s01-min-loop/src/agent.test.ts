import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { addTool, echoTool } from './tools'

/** 与 src/index.ts 演示相同的剧本：先要两次工具，再给最终回答。 */
const script: ModelResponse[] = [
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'add', { a: 2, b: 3 })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_2', 'echo', { text: '算出来了：5' })] },
    finishReason: 'tool_calls',
  },
  { message: { role: 'assistant', content: '2 + 3 = 5。这是最小循环的一次完整运转。' }, finishReason: 'stop' },
]

describe('runLoop', () => {
  it('跑完工具往返并返回最终回答', async () => {
    const model = createMockModel(script)
    const messages = await runLoop(model, [addTool, echoTool], '帮我算 2 + 3')
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '2 + 3 = 5。这是最小循环的一次完整运转。',
    })
  })

  it('把工具结果回喂给模型', async () => {
    const model = createMockModel(script)
    await runLoop(model, [addTool, echoTool], '帮我算 2 + 3')
    expect(model.calls[1]).toContainEqual({ role: 'tool', content: '5', tool_call_id: 'call_1' })
    expect(model.calls[2]).toContainEqual({ role: 'tool', content: '算出来了：5', tool_call_id: 'call_2' })
  })

  it('模型无限要工具时按 maxSteps 中止', async () => {
    const loopStep: ModelResponse = {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('c', 'echo', { text: '再来' })] },
      finishReason: 'tool_calls',
    }
    const model = createMockModel(Array.from({ length: 50 }, () => loopStep))
    await expect(runLoop(model, [echoTool], '停不下来', { maxSteps: 3 })).rejects.toThrow(/maxSteps/)
  })
})
