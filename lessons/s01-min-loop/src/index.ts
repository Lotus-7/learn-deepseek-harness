import { createMockModel, toolCall } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { addTool, echoTool } from './tools'

// 剧本：模型先要两次工具，再给最终回答。换成真模型时，这些决定由模型自己做出。
const model = createMockModel([
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'add', { a: 2, b: 3 })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_2', 'echo', { text: '算出来了：5' })] },
    finishReason: 'tool_calls',
  },
  { message: { role: 'assistant', content: '2 + 3 = 5。这是最小循环的一次完整运转。' }, finishReason: 'stop' },
])

const messages = await runLoop(model, [addTool, echoTool], '帮我算 2 + 3')

for (const m of messages) {
  const detail =
    m.role === 'assistant' && m.tool_calls
      ? `请求工具 ${m.tool_calls.map((c) => c.function.name).join(', ')}`
      : m.role === 'tool'
        ? `工具结果：${m.content}`
        : (m.content ?? '')
  console.log(`[${m.role}] ${detail}`)
}
