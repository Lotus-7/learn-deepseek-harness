import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { registryOf } from './registry'
import { SessionLog } from './log'
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

describe('runLoop × 会话日志', () => {
  /** 跑一遍演示剧本，返回 (model, log) 供对拍。 */
  async function runDemo(): Promise<{ model: ReturnType<typeof createMockModel>; log: SessionLog }> {
    const model = createMockModel(script)
    const log = new SessionLog()
    await runLoop(model, demoRegistry(), '帮我算 2 + 3，然后删掉 a.txt', { log, preExecute: [requireForce] })
    return { model, log }
  }

  it('每个事实都落事件：完整事件序列如预期（turn 边界 + 产消息事件 + 调用事实）', async () => {
    const { log } = await runDemo()
    expect(log.events.map((event) => event.type)).toEqual([
      'turn/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'assistant/message',
      'tool/call',
      'tool/result',
      'assistant/message',
      'tool/call',
      'tool/result',
      'assistant/message',
      'tool/call',
      'tool/result',
      'assistant/message',
      'turn/end',
    ])
    expect(log.events.map((event) => event.seq)).toEqual(log.events.map((_, index) => index))
  })

  it('模型可见 = 已落日志：每次模型请求都等于「截至该次调用前」日志前缀的投影', async () => {
    const { model, log } = await runDemo()
    const requestPrefixes = log.events
      .map((event, index) => (event.type === 'assistant/message' ? index : -1))
      .filter((index) => index >= 0)
      .map((index) => SessionLog.replay(log.events.slice(0, index)).deriveMessages())
    expect(requestPrefixes).toHaveLength(model.calls.length)
    // 对拍：模型实际收到的每一次请求，都能仅凭日志前缀重建出来。
    expect(model.calls).toEqual(requestPrefixes)
  })

  it('返回值就是投影：runLoop 的返回与 log.deriveMessages() 完全一致', async () => {
    const model = createMockModel(script)
    const log = new SessionLog()
    const messages = await runLoop(model, demoRegistry(), '帮我算 2 + 3，然后删掉 a.txt', {
      log,
      preExecute: [requireForce],
    })
    expect(messages).toEqual(log.deriveMessages())
  })

  it('传入同一日志续写：turn 编号接着数，第二轮模型能看到第一轮全部历史', async () => {
    const model = createMockModel(script)
    const log = new SessionLog()
    await runLoop(model, demoRegistry(), '帮我算 2 + 3，然后删掉 a.txt', { log, preExecute: [requireForce] })
    const historyAfterRoundOne = log.deriveMessages()
    const roundTwo = createMockModel([{ message: { role: 'assistant', content: '第二轮回答。' }, finishReason: 'stop' }])
    await runLoop(roundTwo, demoRegistry(), '再确认一下结果', { log })
    const events = log.events.map((event) => event.type)
    expect(events.filter((type) => type === 'turn/start')).toHaveLength(2)
    expect(events.filter((type) => type === 'turn/end')).toHaveLength(2)
    expect(log.nextTurn()).toBe(3)
    // 第二轮第一次请求 = 第一轮全部派生历史 + 新 turn 的用户输入
    expect(roundTwo.calls[0]).toEqual([...historyAfterRoundOne, { role: 'user', content: '再确认一下结果' }])
  })

  it('maxSteps 中止时不写 turn/end：日志留下未闭合的 turn', async () => {
    const loopStep: ModelResponse = {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('c', 'echo', { text: '再来' })] },
      finishReason: 'tool_calls',
    }
    const model = createMockModel(Array.from({ length: 50 }, () => loopStep))
    const log = new SessionLog()
    await expect(
      runLoop(model, registryOf(echoTool), '停不下来', { log, maxSteps: 3 }),
    ).rejects.toThrow(/maxSteps/)
    expect(log.events.filter((event) => event.type === 'turn/start')).toHaveLength(1)
    expect(log.events.filter((event) => event.type === 'turn/end')).toHaveLength(0)
    // 未闭合的 turn 不是合法的 fork 起点
    expect(() => log.fork()).toThrow(/未闭合的 turn/)
  })
})
