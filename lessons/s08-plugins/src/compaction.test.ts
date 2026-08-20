import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { registryOf } from './registry'
import { SessionLog, type LoggedEvent } from './log'
import {
  deterministicSummarize,
  estimateTextTokens,
  estimateTokens,
  maybeCompact,
  type CompactionOptions,
} from './compaction'
import { echoTool, searchLogsTool } from './tools'

/** 演示同款压缩策略：估算口径的阈值 + 尾部窗口 4 条 + 确定性摘要器。 */
const demoCompaction: CompactionOptions = { threshold: 700, keepTail: 4, summarize: deterministicSummarize }

/** 一个请求 search_logs 的步骤（输出 24 行日志，估算约 228 token——推高预算的燃料）。 */
const searchStep = (id: string, query: string): ModelResponse => ({
  message: { role: 'assistant', content: null, tool_calls: [toolCall(id, 'search_logs', { query })] },
  finishReason: 'tool_calls',
})

const answer = (text: string): ModelResponse => ({ message: { role: 'assistant', content: text }, finishReason: 'stop' })

/**
 * 搭一个两轮工具往返的完整日志：u1 → a1(tool_calls) → t1 → a2(tool_calls) → t2 → a3(回答) → turn 闭。
 * 两条工具结果都是 search_logs 的 24 行长输出——头部要有足够体量，摘要才压得动它。
 */
async function sampleLog(): Promise<SessionLog> {
  const longResult = await searchLogsTool.execute({ query: 'timeout' })
  const log = new SessionLog()
  log.append({ type: 'turn/start', turn: 1 })
  log.append({ type: 'user/message', content: '我们集群有 47 台节点，查一下 timeout 日志' })
  log.append({
    type: 'assistant/message',
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'search_logs', { query: 'timeout' })] },
  })
  log.append({ type: 'tool/call', turn: 1, callId: 'call_1', name: 'search_logs', arguments: '{"query":"timeout"}' })
  log.append({ type: 'tool/result', callId: 'call_1', output: longResult })
  log.append({
    type: 'assistant/message',
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_2', 'search_logs', { query: 'restart' })] },
  })
  log.append({ type: 'tool/call', turn: 1, callId: 'call_2', name: 'search_logs', arguments: '{"query":"restart"}' })
  log.append({ type: 'tool/result', callId: 'call_2', output: longResult })
  log.append({ type: 'assistant/message', message: { role: 'assistant', content: 'timeout 与 restart 都集中在 svc-01。' } })
  log.append({ type: 'turn/end', turn: 1, reason: 'completed' })
  return log
}

describe('estimateTokens：教学近似口径', () => {
  it('中文按字、英文按词：同样输入恒定输出', () => {
    expect(estimateTextTokens('你好世界')).toBe(4)
    expect(estimateTextTokens('hello brave world')).toBe(3)
    expect(estimateTextTokens('集群有 47 台节点')).toBe(7) // 集群有 / 47 / 台节点
  })

  it('每条消息计固定开销；tool_calls 按工具名与参数串估算', () => {
    expect(estimateTokens([{ role: 'user', content: '你好' }])).toBe(6) // 4 开销 + 2 字
    const withCalls = estimateTokens([
      { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'echo', { text: '你好' })] },
    ])
    expect(withCalls).toBeGreaterThan(estimateTokens([{ role: 'assistant', content: null }]))
  })
})

describe('maybeCompact：阈值与选区', () => {
  it('未超阈值不压缩：日志一个事件都不多', async () => {
    const log = await sampleLog()
    const before = log.events.length
    expect(await maybeCompact(log, demoCompaction)).toBe(false)
    expect(log.events).toHaveLength(before)
  })

  it('超阈值压缩：头部交给摘要器，落一条 session/compacted 事件', async () => {
    const log = await sampleLog()
    const compactedHead: string[][] = []
    const summarize = async (messages: readonly { role: string }[]): Promise<string> => {
      compactedHead.push(messages.map((m) => m.role))
      return '集群 47 台节点；两轮日志检索已完成，timeout 与 restart 集中在 svc-01。'
    }
    // keepTail=1：切点在最后一条（回答）之前，头部是完整的两轮往返
    expect(await maybeCompact(log, { threshold: 10, keepTail: 1, summarize })).toBe(true)
    expect(log.events.at(-1)).toMatchObject({ type: 'session/compacted', shadowedCount: 5 })
    expect(compactedHead).toEqual([['user', 'assistant', 'tool', 'assistant', 'tool']])
  })

  it('尾部窗口不拆 tool_calls/result 配对：切点落在 tool 消息上时整体左移', async () => {
    const log = await sampleLog()
    // keepTail=2 的朴素切点落在 t2（tool 消息）上——配对安全规则左移到 a2，
    // 让 a2 的 tool_calls 与 t2 一起留在尾部；头部以完整的 [u1, a1, t1] 为界。
    expect(await maybeCompact(log, { threshold: 480, keepTail: 2, summarize: deterministicSummarize })).toBe(true)
    const derived = log.deriveMessages()
    expect(derived).toHaveLength(4) // summary + 尾部 3 条
    expect(derived[0]).toMatchObject({ role: 'user' })
    expect(derived[1]).toMatchObject({ role: 'assistant' }) // a2 带 tool_calls
    expect(derived[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_2' }) // 它的 t2，不悬空
    expect(derived[3]).toMatchObject({ role: 'assistant' })
  })

  it('摘要压不过被压掉的头部时不落事件（压不动就别压）', async () => {
    const log = await sampleLog()
    const verbose = '摘要'.repeat(500)
    expect(await maybeCompact(log, { threshold: 10, keepTail: 2, summarize: async () => verbose })).toBe(false)
    expect(log.events.some((event) => event.type === 'session/compacted')).toBe(false)
    expect(log.deriveMessages()).toHaveLength(6)
  })

  it('整个历史都是尾部（头部为空）时没有可压的对象', async () => {
    const log = await sampleLog()
    expect(await maybeCompact(log, { threshold: 10, keepTail: 6, summarize: deterministicSummarize })).toBe(false)
    expect(log.events.some((event) => event.type === 'session/compacted')).toBe(false)
  })
})

describe('压缩事件与派生/重放/fork', () => {
  it('压缩后派生历史 = summary（user 形态）+ 尾部窗口，且低于阈值', async () => {
    const log = await sampleLog()
    const options: CompactionOptions = { threshold: 480, keepTail: 2, summarize: deterministicSummarize }
    expect(estimateTokens(log.deriveMessages())).toBeGreaterThan(options.threshold)
    await maybeCompact(log, options)
    const event = log.events.at(-1)
    if (event?.type !== 'session/compacted') throw new Error('应已压缩')
    const derived = log.deriveMessages()
    expect(derived).toHaveLength(4) // summary + 尾部 3 条（keepTail=2 的朴素切点在 tool 消息上，左移后尾部扩到 3 条）
    expect(derived[0]).toMatchObject({ role: 'user', content: event.summary })
    expect(estimateTokens(derived)).toBe(event.tokensAfter)
    expect(event.tokensAfter).toBeLessThan(event.tokensBefore)
    expect(event.tokensAfter).toBeLessThan(options.threshold)
  })

  it('压缩事件落日志且重放重建一致：仅凭事件列表得到同样的压缩视图', async () => {
    const log = await sampleLog()
    await maybeCompact(log, { threshold: 480, keepTail: 2, summarize: deterministicSummarize })
    expect(SessionLog.replay(log.events).deriveMessages()).toEqual(log.deriveMessages())
  })

  it('被压掉的事件没有删除：压缩点之前 fork 的支线派生出未压缩的完整历史', async () => {
    const log = await sampleLog()
    await maybeCompact(log, { threshold: 480, keepTail: 2, summarize: deterministicSummarize })
    expect(log.deriveMessages()).toHaveLength(4) // 压缩视图：summary + 尾部 3 条
    // fork 落在闭合的 turn 边界（s03 的规矩）：seq=9 是 turn/end，
    // 压缩事件（seq=10）还没发生——支线派生出未压缩的完整历史。
    const child = log.fork(9)
    expect(child.deriveMessages()).toHaveLength(6)
    expect(child.deriveMessages().at(0)).toMatchObject({ role: 'user', content: '我们集群有 47 台节点，查一下 timeout 日志' })
  })
})

describe('runLoop 集成：步骤边界的压缩', () => {
  const registry = registryOf(echoTool, searchLogsTool)
  const turnOneUser = '我们的生产集群一共 47 台节点，最近超时报警很多，帮我从部署日志里查一下 timeout 和 restart。'

  /** 演示同款两 turn 剧本：turn 1 攒账，turn 2 的第 2 个步骤边界触发压缩。 */
  async function runTwoTurns(compaction: CompactionOptions): Promise<{
    log: SessionLog
    turnOne: ReturnType<typeof createMockModel>
    turnTwo: ReturnType<typeof createMockModel>
  }> {
    const log = new SessionLog()
    const turnOne = createMockModel([
      searchStep('t1', 'timeout'),
      searchStep('t2', 'restart'),
      answer('两种模式各命中 24 行，初步判断 svc-01 过载。'),
    ])
    await runLoop(turnOne, registry, turnOneUser, { log, compaction })
    const turnTwo = createMockModel([searchStep('t3', 'upstream_reset'), answer('upstream_reset 与 restart 重合，坐实上游问题。')])
    await runLoop(turnTwo, registry, '继续深挖 upstream_reset。', { log, compaction })
    return { log, turnOne, turnTwo }
  }

  it('超阈值触发且（本场景）只触发一次；压缩发生在模型请求发出之前', async () => {
    const { log, turnOne, turnTwo } = await runTwoTurns(demoCompaction)
    expect(log.events.filter((event) => event.type === 'session/compacted')).toHaveLength(1)
    // 压缩后 turn 2 的第二次请求：第一条就是摘要，原文整条已不在输入里
    const request = turnTwo.calls[1]!
    expect(request[0]).toMatchObject({ role: 'user' })
    expect(request[0]!.content).toContain('47')
    expect(request.some((m) => m.content === turnOneUser)).toBe(false)
    // 模型可见 = 已落日志：两次 turn 的每次请求都等于「截至该次调用前」日志前缀的投影
    // （s03 的宪法在压缩在场时依然成立——压缩事件本身也是投影规则的一部分）。
    const calls = [...turnOne.calls, ...turnTwo.calls]
    const assistantIndexes = log.events
      .map((event, index) => (event.type === 'assistant/message' ? index : -1))
      .filter((index) => index >= 0)
    expect(calls).toEqual(assistantIndexes.map((index) => SessionLog.replay(log.events.slice(0, index)).deriveMessages()))
  })

  it('未超阈值不压缩：短对话零压缩事件', async () => {
    const log = new SessionLog()
    const model = createMockModel([answer('好。')])
    await runLoop(model, registryOf(echoTool), '你好', { log, compaction: demoCompaction })
    expect(log.events.some((event) => event.type === 'session/compacted')).toBe(false)
  })

  it('多级压缩：压完仍超阈值时同一边界不连压，下一个边界再压（摘要的摘要）', async () => {
    // keepTail=6 让后两条 24 行日志都留在尾部：第一次压缩后估算仍高于阈值，
    // 但同一边界至多压一次——turn 3 的第一个边界才落第二条 session/compacted。
    const compaction: CompactionOptions = { threshold: 620, keepTail: 6, summarize: deterministicSummarize }
    const { log } = await runTwoTurns(compaction)
    expect(log.events.filter((event) => event.type === 'session/compacted')).toHaveLength(1)
    expect(estimateTokens(log.deriveMessages())).toBeGreaterThan(compaction.threshold)

    const turnThree = createMockModel([answer('判断不变。')])
    await runLoop(turnThree, registry, '总结一下结论。', { log, compaction })
    const events = log.events.filter((event) => event.type === 'session/compacted')
    expect(events).toHaveLength(2)
    // 第二级摘要的头部包含第一级摘要：47 这一数字事实穿过两级压缩幸存
    const second = events[1] as Extract<LoggedEvent, { type: 'session/compacted' }>
    expect(second.summary).toContain('47')
    expect(log.deriveMessages()[0]).toMatchObject({ role: 'user', content: second.summary })
  })
})
