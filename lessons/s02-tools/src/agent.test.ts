import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { registryOf } from './registry'
import { addTool, deleteFileTool, echoTool } from './tools'

/** 与 src/index.ts 演示相同的剧本：坏参数 → 校验错误 → 修正 → 守卫否决 → 补 force → 回答。 */
const script: ModelResponse[] = [
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
]

/** 演示同款守卫：delete_file 必须显式 force: true。 */
const requireForce = (tool: { name: string }, args: Record<string, unknown>): string | undefined =>
  tool.name === 'delete_file' && args.force !== true
    ? 'delete_file 需要 force: true 才能执行，请确认后带上该参数重试'
    : undefined

const demoRegistry = () => registryOf(addTool, echoTool, deleteFileTool)

describe('runLoop', () => {
  it('跑完工具往返并返回最终回答', async () => {
    const model = createMockModel(script)
    const messages = await runLoop(model, demoRegistry(), '帮我算 2 + 3，然后删掉 a.txt', {
      preExecute: [requireForce],
    })
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '2 + 3 = 5，a.txt 已删除。参数不合规、被守卫拦下都不是事故：错误文本会回到我这里，修正后重试即可。',
    })
  })

  it('把工具结果回喂给模型', async () => {
    const model = createMockModel(script)
    await runLoop(model, demoRegistry(), '帮我算 2 + 3，然后删掉 a.txt', { preExecute: [requireForce] })
    expect(model.calls[2]).toContainEqual({ role: 'tool', content: '5', tool_call_id: 'call_2' })
    expect(model.calls[4]).toContainEqual({ role: 'tool', content: '已删除 a.txt', tool_call_id: 'call_4' })
  })

  it('模型无限要工具时按 maxSteps 中止', async () => {
    const loopStep: ModelResponse = {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('c', 'echo', { text: '再来' })] },
      finishReason: 'tool_calls',
    }
    const model = createMockModel(Array.from({ length: 50 }, () => loopStep))
    await expect(runLoop(model, registryOf(echoTool), '停不下来', { maxSteps: 3 })).rejects.toThrow(/maxSteps/)
  })

  it('坏参数的校验错误作为 tool 结果回喂，模型看得见且可修正', async () => {
    const model = createMockModel(script)
    await runLoop(model, demoRegistry(), '帮我算 2 + 3，然后删掉 a.txt', { preExecute: [requireForce] })
    expect(model.calls[1]).toContainEqual({
      role: 'tool',
      content: '参数校验失败：参数 a 应为 integer，实际是 string（"两"）',
      tool_call_id: 'call_1',
    })
  })

  it('守卫否决的原因同样作为 tool 结果回喂', async () => {
    const model = createMockModel(script)
    await runLoop(model, demoRegistry(), '帮我算 2 + 3，然后删掉 a.txt', { preExecute: [requireForce] })
    expect(model.calls[3]).toContainEqual({
      role: 'tool',
      content: '守卫否决：delete_file 需要 force: true 才能执行，请确认后带上该参数重试',
      tool_call_id: 'call_3',
    })
  })

  it('arguments 是合法 JSON 但根不是对象时，校验失败回喂而非崩溃', async () => {
    // toolCall 只序列化对象参数；标量根（合法 JSON、非对象）剧本需覆写 arguments
    const scalarRoot: ModelResponse[] = [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ ...toolCall('call_1', 'add', {}), function: { name: 'add', arguments: '"5"' } }],
        },
        finishReason: 'tool_calls',
      },
      { message: { role: 'assistant', content: '换成对象参数重试。' }, finishReason: 'stop' },
    ]
    const model = createMockModel(scalarRoot)
    await runLoop(model, demoRegistry(), '帮我算 2 + 3')
    expect(model.calls[1]).toContainEqual({
      role: 'tool',
      content: '参数校验失败：arguments 根必须是 JSON 对象，实际是 string（"5"）',
      tool_call_id: 'call_1',
    })
  })
})
