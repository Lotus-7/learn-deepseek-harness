import { describe, expect, it } from 'vitest'
import { toolCall } from '@learn-dsh/mock-model'
import { SessionLog, type LoggedEvent } from './log'

/** 搭一个跨完整往返的小事件流：turn 开、用户输入、带 tool_calls 的模型消息、结果、turn 闭。 */
function sampleLog(): SessionLog {
  const log = new SessionLog()
  log.append({ type: 'turn/start', turn: 1 })
  log.append({ type: 'user/message', content: '帮我算 2 + 3' })
  log.append({
    type: 'assistant/message',
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'add', { a: 2, b: 3 })] },
  })
  log.append({ type: 'tool/call', turn: 1, callId: 'call_1', name: 'add', arguments: '{"a":2,"b":3}' })
  log.append({ type: 'tool/result', callId: 'call_1', output: '5' })
  log.append({
    type: 'assistant/message',
    message: { role: 'assistant', content: '2 + 3 = 5。' },
  })
  log.append({ type: 'turn/end', turn: 1, reason: 'completed' })
  return log
}

describe('SessionLog：append-only', () => {
  it('append 逐条赋 seq，从 0 连续递增', () => {
    const log = sampleLog()
    expect(log.events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('events 是只读快照：改写任何历史位置都抛 TypeError', () => {
    const log = sampleLog()
    expect(() => {
      ;(log.events as { type: string }[])[0]!.type = 'turn/end'
    }).toThrow(TypeError)
    expect(Object.isFrozen(log.events)).toBe(true)
    expect(Object.isFrozen(log.events[1])).toBe(true)
  })

  it('事件深冻结：嵌套的 tool_calls 与消息内容同样改不得', () => {
    const log = sampleLog()
    const event = log.events[2] as Extract<LoggedEvent, { type: 'assistant/message' }>
    expect(event.type).toBe('assistant/message')
    expect(() => {
      event.message.role = 'user'
    }).toThrow(TypeError)
    expect(() => {
      event.message.tool_calls![0]!.function.name = 'echo'
    }).toThrow(TypeError)
  })

  it('先前取到的快照不会随后续 append 增长', () => {
    const log = new SessionLog()
    log.append({ type: 'turn/start', turn: 1 })
    const early = log.events
    log.append({ type: 'user/message', content: '第二条' })
    expect(early).toHaveLength(1)
    expect(log.events).toHaveLength(2)
  })
})

describe('SessionLog：deriveMessages 投影', () => {
  it('只有产消息的三类事件投影；turn 边界与 tool/call 不投影', () => {
    const messages = sampleLog().deriveMessages()
    expect(messages).toEqual([
      { role: 'user', content: '帮我算 2 + 3' },
      { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'add', { a: 2, b: 3 })] },
      { role: 'tool', content: '5', tool_call_id: 'call_1' },
      { role: 'assistant', content: '2 + 3 = 5。' },
    ])
  })

  it('assistant 的投影消息与冻结事件共享：拿不到可变的另一份历史', () => {
    const log = sampleLog()
    const last = log.deriveMessages().at(-1)
    expect(last?.role).toBe('assistant')
    expect(() => {
      ;(last as { content: string }).content = '改掉'
    }).toThrow(TypeError)
  })
})

describe('SessionLog：replay 重建', () => {
  it('仅凭事件列表重建出等价的派生历史', () => {
    const log = sampleLog()
    const rebuilt = SessionLog.replay(log.events)
    expect(rebuilt.deriveMessages()).toEqual(log.deriveMessages())
    expect(rebuilt.events.map((event) => event.seq)).toEqual(log.events.map((event) => event.seq))
    expect(rebuilt.nextTurn()).toBe(log.nextTurn())
  })

  it('seq 断裂的日志拒绝重放，而不是静默重排', () => {
    const log = sampleLog()
    const torn = log.events.slice(2)
    expect(() => SessionLog.replay(torn)).toThrow(/seq 从 0 连续递增/)
  })
})

describe('SessionLog：fork 边界语义', () => {
  it('省略边界 = 取到最后一个事件；边界是闭区间（含该 seq）', () => {
    const log = sampleLog()
    expect(log.fork().events).toHaveLength(7)
    // 双 turn 日志：seq=6 是第一个 turn/end，闭区间意味着它本身进入前缀（共 7 个事件）
    log.append({ type: 'turn/start', turn: 2 })
    log.append({ type: 'user/message', content: '再算 7 + 8' })
    log.append({ type: 'turn/end', turn: 2, reason: 'completed' })
    expect(log.fork(6).events).toHaveLength(7)
    expect(log.fork(6).events.at(-1)?.type).toBe('turn/end')
  })

  it('边界越界或不是安全整数时拒绝', () => {
    const log = sampleLog()
    expect(() => log.fork(7)).toThrow(/不在日志范围内/)
    expect(() => log.fork(-1)).toThrow(/不在日志范围内/)
    expect(() => log.fork(1.5)).toThrow(/不在日志范围内/)
  })

  it('边界落在未闭合的 turn 内时拒绝（半截 turn 不是合法续写起点）', () => {
    const log = sampleLog()
    // seq=3 在 turn/start 之后、turn/end 之前
    expect(() => log.fork(3)).toThrow(/未闭合的 turn/)
  })

  it('子日志续写不影响母日志；母日志再写也不影响已分叉的子日志', () => {
    const parent = sampleLog()
    const child = parent.fork(6)
    child.append({ type: 'turn/start', turn: 2 })
    child.append({ type: 'user/message', content: '再算 7 + 8' })
    expect(parent.events).toHaveLength(7)
    expect(parent.deriveMessages().at(-1)?.content).toBe('2 + 3 = 5。')

    parent.append({ type: 'turn/start', turn: 2 })
    expect(child.events).toHaveLength(9)
  })

  it('浅历史复制：子母日志共享同一批冻结事件对象', () => {
    const parent = sampleLog()
    const child = parent.fork(6)
    expect(parent.events.every((event, index) => Object.is(child.events[index], event))).toBe(true)
  })

  it('fork 后 nextTurn 从派生历史接着数，续写的 turn 编号正确', () => {
    const log = sampleLog()
    expect(log.fork(6).nextTurn()).toBe(2)
  })
})
