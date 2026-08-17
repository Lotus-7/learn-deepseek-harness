import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall } from './index'

const tools = [{ name: 'add', description: '', parameters: {} }]

describe('createMockModel', () => {
  it('按顺序回放脚本响应', async () => {
    const model = createMockModel([
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'add', { a: 1 })] },
        finishReason: 'tool_calls',
      },
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
    ])
    const first = await model([{ role: 'user', content: 'hi' }], tools)
    expect(first.finishReason).toBe('tool_calls')
    const second = await model([{ role: 'user', content: 'hi' }, first.message], tools)
    expect(second.message.content).toBe('done')
  })

  it('记录每次请求的 messages 快照', async () => {
    const model = createMockModel([{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }])
    await model([{ role: 'user', content: 'q' }], [])
    expect(model.calls).toEqual([[{ role: 'user', content: 'q' }]])
  })

  it('脚本耗尽后抛出可诊断的错误', async () => {
    const model = createMockModel([])
    await expect(model([{ role: 'user', content: 'q' }], [])).rejects.toThrow(/耗尽/)
  })
})

describe('toolCall', () => {
  it('构造 function 调用并把参数序列化为 JSON 字符串', () => {
    expect(toolCall('id1', 'add', { a: 2, b: 3 })).toEqual({
      id: 'id1',
      type: 'function',
      function: { name: 'add', arguments: '{"a":2,"b":3}' },
    })
  })
})
