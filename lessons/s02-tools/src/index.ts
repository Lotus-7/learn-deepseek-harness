import { createMockModel, toolCall } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { ToolRegistry } from './registry'
import type { PreExecuteHook } from './pipeline'
import { addTool, deleteFileTool, echoTool } from './tools'

// 剧本：模型第一次用坏参数调 add（a 是字符串），收到校验错误后修正重试；
// 再调 delete_file 没带 force，被守卫否决，补上 force 重试成功。
// 换成真模型时，这些修正都由模型自己看到错误文本后做出。
const model = createMockModel([
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'add', { a: '两', b: 3 })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_2', 'add', { a: 2, b: 3 })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_3', 'delete_file', { path: 'a.txt' })] },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call_4', 'delete_file', { path: 'a.txt', force: true })],
    },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content: '2 + 3 = 5，a.txt 已删除。参数不合规、被守卫拦下都不是事故：错误文本会回到我这里，修正后重试即可。',
    },
    finishReason: 'stop',
  },
])

const registry = new ToolRegistry()
registry.register(addTool)
registry.register(echoTool)
registry.register(deleteFileTool)

// preExecute 守卫：delete_file 必须显式 force: true 才放行，否则否决并说明原因。
const requireForce: PreExecuteHook = (tool, args) =>
  tool.name === 'delete_file' && args.force !== true
    ? 'delete_file 需要 force: true 才能执行，请确认后带上该参数重试'
    : undefined

const messages = await runLoop(model, registry, '帮我算 2 + 3，然后删掉 a.txt', {
  preExecute: [requireForce],
})

for (const m of messages) {
  const detail =
    m.role === 'assistant' && m.tool_calls
      ? `请求工具 ${m.tool_calls.map((c) => c.function.name).join(', ')}`
      : m.role === 'tool'
        ? `工具结果：${m.content}`
        : (m.content ?? '')
  console.log(`[${m.role}] ${detail}`)
}
