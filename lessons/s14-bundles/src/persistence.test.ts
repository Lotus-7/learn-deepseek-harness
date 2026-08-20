import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx } from './cordis'
import { SessionLog, type LoggedEvent } from './log'
import { estimateTokens } from './compaction'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { compactionPlugin } from './plugin-compaction'
import { loopPlugin } from './plugin-loop'
import { durablePlugin } from './plugin-durable'
import {
  forkSessionFile,
  interruptedClosers,
  makeScratchDir,
  removeScratchDir,
  resumeSession,
  scanFile,
  SessionFile,
  SESSION_FORMAT_VERSION,
  type SessionHeader,
} from './persistence'
import { echoTool } from './tools'
import { renderTranscript } from './transcript'

/**
 * 轻装配：五件套里只挂本课要的（model + tools/session + 可选 durable +
 * 可选 compaction + loop），跑真实 turn（真插件协作，不是手搓日志）。
 * @param script - 剧本。
 * @param path - 会话文件路径（提供则落盘）。
 * @param seed - resume 种子（提供则重放构造）。
 * @param compaction - 传入则挂压缩插件（触发 session/compacted 事件用）。
 */
function rig(
  script: readonly ModelResponse[],
  path?: string,
  seed?: readonly LoggedEvent[],
  compaction?: { threshold: number },
) {
  const ctx = new Ctx()
  const model = createMockModel([...script])
  ctx.mount(modelPlugin(model))
  const file = path === undefined ? undefined : SessionFile.openAppend(path)
  ctx.mount(toolsSessionPlugin([echoTool], seed === undefined ? {} : { seed }))
  if (file !== undefined) ctx.mount(durablePlugin(file))
  if (compaction !== undefined) {
    ctx.mount(compactionPlugin({ threshold: compaction.threshold, keepTail: 2, summarize: async (messages) => `摘要 ${messages.length} 条` }))
  }
  ctx.mount(loopPlugin())
  return { ctx, model, file }
}

/** 一问一答 + 一次工具调用的剧本（跑出 7 条事件）。 */
const echoScript: ModelResponse[] = [
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'echo', { text: '榴莲酥' })] },
    finishReason: 'tool_calls',
  },
  { message: { role: 'assistant', content: '暗号记住：榴莲酥。' }, finishReason: 'stop' },
]

/** 两个完整 turn 的剧本（twoTurnFile 用；callId 各 turn 不同）。 */
const twoTurnScript: ModelResponse[] = [
  ...echoScript,
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('c2', 'echo', { text: '第二遍' })] },
    finishReason: 'tool_calls',
  },
  { message: { role: 'assistant', content: '第二问答完。' }, finishReason: 'stop' },
]

/** 逐事件（含全部字段）相等，比 toEqual 更不宽容（键序差异也会暴露）。 */
function sameEvents(actual: readonly LoggedEvent[], expected: readonly LoggedEvent[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((event, index) => JSON.stringify(event) === JSON.stringify(expected[index]))
  )
}

/** 跑 rig 得到一个完整 turn 的日志与文件事件。 */
async function runTurn(r: ReturnType<typeof rig>, input: string): Promise<LoggedEvent[]> {
  await r.ctx.get('agent').run(input)
  return [...r.ctx.get('sessions').log.events]
}

describe('落盘：落账即持久', () => {
  let dir: string
  beforeEach(() => {
    dir = makeScratchDir('s13-test-')
  })
  afterEach(() => {
    removeScratchDir(dir)
  })

  it('append 返回即已落盘：跑完 turn 立刻读文件，与内存日志逐事件一致', async () => {
    const path = join(dir, 's.jsonl')
    SessionFile.materialize(path, header('s'), [])
    const events = await runTurn(rig(echoScript, path), '记住暗号：榴莲酥')
    expect(sameEvents(scanFile(path).events, events)).toBe(true)
    expect(scanFile(path).events.map((event) => event.seq)).toEqual(events.map((event) => event.seq))
  })

  it('文件每行一个事件：seq 即行号减一头行', async () => {
    const path = join(dir, 's.jsonl')
    SessionFile.materialize(path, header('s'), [])
    const events = await runTurn(rig(echoScript, path), '记住暗号：榴莲酥')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(events.length + 1)
    expect(lines[0]).toContain('"type":"session"')
    for (const [index, line] of lines.slice(1).entries()) {
      expect((JSON.parse(line) as LoggedEvent).seq).toBe(index)
    }
  })

  it('materialize 拒绝覆盖既有文件（committed 日志不可重建）', () => {
    const path = join(dir, 's.jsonl')
    SessionFile.materialize(path, header('s'), [])
    expect(() => SessionFile.materialize(path, header('s'), [])).toThrow(/已存在/)
  })

  it('压缩事件也无损落盘：重放的派生历史与 estimateTokens 全等', async () => {
    const path = join(dir, 's.jsonl')
    SessionFile.materialize(path, header('s'), [])
    // 头部内容刻意长：压缩检查点带固定前言框架，「压出来的必须更小」要求
    // 被压头部大于框架成本，短对话压不动（maybeCompact 的放弃条件 ③）。
    const long = (n: number) => `这是第${n}个回答，内容刻意写长以超过压缩检查点前言框架的固定成本，从而让摘要真的变小。`.repeat(2)
    const script: ModelResponse[] = [
      { message: { role: 'assistant', content: long(1) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: long(2) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: '第三个回答。' }, finishReason: 'stop' },
    ]
    const { ctx } = rig(script, path, undefined, { threshold: 1 })
    await ctx.get('agent').run('第一问')
    await ctx.get('agent').run('第二问')
    await ctx.get('agent').run('第三问')
    const log = ctx.get('sessions').log
    expect(log.events.some((event) => event.type === 'session/compacted')).toBe(true)
    const scan = scanFile(path)
    expect(sameEvents(scan.events, log.events)).toBe(true)
    const rebuilt = SessionLog.replay(scan.events)
    expect(rebuilt.deriveMessages()).toEqual(log.deriveMessages())
    expect(estimateTokens(rebuilt.deriveMessages())).toBe(estimateTokens(log.deriveMessages()))
    expect(rebuilt.nextTurn()).toBe(log.nextTurn())
  })
})

describe('重放：resume 同一文件', () => {
  let dir: string
  beforeEach(() => {
    dir = makeScratchDir('s13-test-')
  })
  afterEach(() => {
    removeScratchDir(dir)
  })

  it('resume 重放与原实例逐事件一致；续写 seq 续接不重置', async () => {
    const path = join(dir, 's.jsonl')
    SessionFile.materialize(path, header('s'), [])
    const first = rig(echoScript, path)
    const before = await runTurn(first, '记住暗号：榴莲酥')
    first.file?.close()
    // 「重启」：新实例只看文件。
    const resumed = resumeSession(path)
    expect(resumed.warnings).toEqual([])
    expect(sameEvents(resumed.events, before)).toBe(true)
    const second = rig(
      [{ message: { role: 'assistant', content: '暗号是榴莲酥。' }, finishReason: 'stop' }],
      path,
      resumed.events,
    )
    expect(second.ctx.get('sessions').log.nextTurn()).toBe(2)
    const after = await runTurn(second, '暗号是什么？')
    // 新事件从 len 续接：seq 连续、没有重置。
    expect(after.slice(before.length).map((event) => event.seq)).toEqual(
      Array.from({ length: after.length - before.length }, (_, i) => before.length + i),
    )
    // 第一次请求带着重启前的历史。
    expect(
      second.model.calls[0]?.some((message) => message.role === 'user' && message.content?.includes('记住暗号')),
    ).toBe(true)
    expect(sameEvents(scanFile(path).events, after)).toBe(true)
  })

  it('干净文件 resume 零警告；重放出的 transcript 与原实例逐行相同', async () => {
    const path = join(dir, 's.jsonl')
    SessionFile.materialize(path, header('s'), [])
    const first = rig(echoScript, path)
    const before = await runTurn(first, '记住暗号：榴莲酥')
    first.file?.close()
    const resumed = resumeSession(path)
    expect(resumed.warnings).toEqual([])
    expect(renderTranscript(resumed.events)).toEqual(renderTranscript(before))
  })
})

describe('崩溃残迹：截断与拒绝的分流', () => {
  let dir: string
  beforeEach(() => {
    dir = makeScratchDir('s13-test-')
  })
  afterEach(() => {
    removeScratchDir(dir)
  })

  /** 造一个两 turn 的干净文件，返回路径与两 turn 各自的事件数。 */
  async function twoTurnFile(): Promise<{ path: string; firstTurnEvents: number; allEvents: number }> {
    const path = join(dir, 's.jsonl')
    SessionFile.materialize(path, header('s'), [])
    const r = rig(twoTurnScript, path)
    await r.ctx.get('agent').run('第一问')
    const afterFirst = r.ctx.get('sessions').log.events.length
    await r.ctx.get('agent').run('第二问')
    r.file?.close()
    return { path, firstTurnEvents: afterFirst, allEvents: r.ctx.get('sessions').log.events.length }
  }

  it('最后一行写到一半（无尾换行）：截到最近完整事件并响亮警告，文件被物理修复', async () => {
    const { path, allEvents } = await twoTurnFile()
    const raw = readFileSync(path, 'utf8')
    // 模拟崩溃：最后一个事件的行（turn 2 的 turn/end）砍掉后半截——
    // 有头无尾、没有换行结尾。这同时制造两件事：torn tail（半行）与
    // 未闭合 turn（turn/end 丢了）——resume 要一起处理。
    const body = raw.slice(0, -1) // 去掉文件末尾换行，露出最后一行
    const lastLine = body.split('\n').at(-1)!
    writeFileSync(path, body.slice(0, body.length - Math.floor(lastLine.length / 2)))
    const resumed = resumeSession(path)
    expect(resumed.warnings.join('\n')).toMatch(/崩溃尾巴/)
    expect(resumed.warnings.join('\n')).toMatch(/未闭合 turn/)
    // 前缀 13 条（最后完整事件 = turn 2 的最终回答）+ 1 条合成 turn/end(aborted)。
    expect(resumed.events).toHaveLength(allEvents)
    expect(resumed.events.at(-1)).toMatchObject({ type: 'turn/end', turn: 2, reason: 'aborted' })
    expect(resumed.events.slice(0, -1).map((event) => event.seq)).toEqual(
      Array.from({ length: allEvents - 1 }, (_, i) => i),
    )
    // 物理修复（截断 + 合成收尾）已落盘：再扫一遍就是干净的。
    const rescan = scanFile(path)
    expect(sameEvents(rescan.events, resumed.events)).toBe(true)
    expect(rescan.closers).toEqual([])
    expect(rescan.tornTail).toBeUndefined()
    // 截断后可以继续追加（文件回到合法 append 起点）。
    const cont = SessionFile.openAppend(path)
    cont.append(resumed.events.at(-1)!)
    cont.close()
  })

  it('committed 区的坏 JSON：拒绝打开，错误带位置与去向', async () => {
    const { path } = await twoTurnFile()
    const lines = readFileSync(path, 'utf8').split('\n')
    // 第三行是 committed 区的完整行，换成非法 JSON（行本身完整：有换行）。
    lines[2] = '{"type":"user/message","content":' // 有换行的坏行
    writeFileSync(path, lines.join('\n'))
    expect(() => resumeSession(path)).toThrow(/committed 区损坏/)
    expect(() => resumeSession(path)).toThrow(/不是合法 JSON/)
  })

  it('committed 区的 seq 断裂：拒绝打开，报期望与实际', async () => {
    const { path } = await twoTurnFile()
    const lines = readFileSync(path, 'utf8').split('\n')
    const event = JSON.parse(lines[2]!) as LoggedEvent
    lines[2] = JSON.stringify({ ...event, seq: 9 })
    writeFileSync(path, lines.join('\n'))
    expect(() => resumeSession(path)).toThrow(/seq 不连续/)
  })

  it('未闭合 turn：完整保留并合成收尾（tool/result 配对 + turn/end(aborted)），且落盘', async () => {
    const path = join(dir, 's.jsonl')
    SessionFile.materialize(path, header('s'), [])
    const r = rig(echoScript, path)
    // 只跑半个 turn：模型请求了 echo、结果落账前「崩溃」——关文件、卸模拟。
    const log = r.ctx.get('sessions').log
    const sessions = r.ctx.get('sessions')
    sessions.append({ type: 'turn/start', turn: 1 })
    sessions.append({ type: 'user/message', content: '半截问题' })
    sessions.append({
      type: 'assistant/message',
      message: { role: 'assistant', content: null, tool_calls: [toolCall('x1', 'echo', { text: 'hi' })] },
    })
    r.file?.close()
    expect(log.events.some((event) => event.type === 'turn/end')).toBe(false)
    const resumed = resumeSession(path)
    expect(resumed.warnings.join('\n')).toMatch(/未闭合 turn/)
    const tail = resumed.events.slice(-2)
    expect(tail[0]).toMatchObject({ type: 'tool/result', callId: 'x1' })
    expect(tail[1]).toMatchObject({ type: 'turn/end', turn: 1, reason: 'aborted' })
    expect(resumed.events.map((event) => event.seq)).toEqual(resumed.events.map((_, i) => i))
    // 收尾已落盘：重扫无残迹、无收尾需求，派生历史可续写。
    const rescan = scanFile(path)
    expect(rescan.tornTail).toBeUndefined()
    expect(rescan.closers).toEqual([])
    expect(sameEvents(rescan.events, resumed.events)).toBe(true)
  })

  it('平衡日志的合成收尾为空', () => {
    const log = new SessionLog()
    log.append({ type: 'turn/start', turn: 1 })
    log.append({ type: 'turn/end', turn: 1, reason: 'completed' })
    expect(interruptedClosers(log.events)).toEqual([])
    expect(interruptedClosers([])).toEqual([])
  })

  it('头行版本不认识：整份拒绝而不是猜着读', async () => {
    const { path } = await twoTurnFile()
    const lines = readFileSync(path, 'utf8').split('\n')
    const head = JSON.parse(lines[0]!) as SessionHeader
    lines[0] = JSON.stringify({ ...head, version: 99 })
    writeFileSync(path, lines.join('\n'))
    expect(() => resumeSession(path)).toThrow(/v99/)
    expect(() => resumeSession(path)).toThrow(/拒绝解释/)
  })

  it('没有完整头行的文件拒绝', () => {
    const path = join(dir, 's.jsonl')
    writeFileSync(path, '{"type":"sess')
    expect(() => scanFile(path)).toThrow(/没有完整头行/)
  })
})

describe('分叉：支线前缀 = 主线前缀', () => {
  let dir: string
  beforeEach(() => {
    dir = makeScratchDir('s13-test-')
  })
  afterEach(() => {
    removeScratchDir(dir)
  })

  it('fork 到 turn/end 边界：谱系落头、前缀逐事件相同、之后互不影响', async () => {
    const path = join(dir, 'main.jsonl')
    SessionFile.materialize(path, header('main'), [])
    const r = rig(twoTurnScript, path)
    await r.ctx.get('agent').run('第一问')
    const boundary = r.ctx.get('sessions').log.events.length - 1
    await r.ctx.get('agent').run('第二问')
    r.file?.close()
    const mainAtFork = scanFile(path).events.length

    const forked = forkSessionFile(path, boundary, join(dir, 'branch.jsonl'), 'branch')
    expect(forked.header.parentSession).toBe('main')
    expect(forked.header.seedLength).toBe(boundary + 1)
    // 支线继续长：自己的 turn，seq 从 seedLength 续接。
    const branchRig = rig(
      [{ message: { role: 'assistant', content: '支线回答。' }, finishReason: 'stop' }],
      join(dir, 'branch.jsonl'),
      forked.events,
    )
    await branchRig.ctx.get('agent').run('支线的问题')
    branchRig.file?.close()
    // 主线也继续长。
    const mainRig2 = rig(
      [{ message: { role: 'assistant', content: '主线回答。' }, finishReason: 'stop' }],
      path,
      scanFile(path).events,
    )
    await mainRig2.ctx.get('agent').run('主线的问题')
    mainRig2.file?.close()

    const mainEvents = scanFile(path).events
    const branchEvents = scanFile(join(dir, 'branch.jsonl')).events
    expect(sameEvents(branchEvents.slice(0, boundary + 1), mainEvents.slice(0, boundary + 1))).toBe(true)
    expect(branchEvents.length).toBeGreaterThan(boundary + 1)
    expect(mainEvents.length).toBeGreaterThan(mainAtFork)
    expect(JSON.stringify(branchEvents.slice(boundary + 1))).not.toContain('主线的问题')
    expect(JSON.stringify(mainEvents.slice(mainAtFork))).not.toContain('支线的问题')
    // 两份日志的共享前缀渲染出逐行相同的 transcript。
    expect(renderTranscript(branchEvents).slice(0, boundary + 1)).toEqual(
      renderTranscript(mainEvents).slice(0, boundary + 1),
    )
  })

  it('fork 边界落在未闭合 turn 内：拒绝（半截 turn 不是续写起点）', async () => {
    const path = join(dir, 'main.jsonl')
    SessionFile.materialize(path, header('main'), [])
    const r = rig(echoScript, path)
    const sessions = r.ctx.get('sessions')
    sessions.append({ type: 'turn/start', turn: 1 })
    sessions.append({ type: 'user/message', content: '半截' })
    r.file?.close()
    expect(() => forkSessionFile(path, undefined, join(dir, 'b.jsonl'), 'b')).toThrow(/未闭合的 turn/)
  })

  it('fork 只继承完整前缀：母文件的崩溃尾巴不进支线', async () => {
    const path = join(dir, 'main.jsonl')
    SessionFile.materialize(path, header('main'), [])
    const r = rig(twoTurnScript, path)
    await r.ctx.get('agent').run('第一问')
    await r.ctx.get('agent').run('第二问')
    r.file?.close()
    // 两个完整 turn 之后补一行「写到一半」的残迹（有头无尾）。
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"seq":99,"type":"turn/sta`)
    const scan = scanFile(path)
    expect(scan.tornTail).toBeDefined()
    // 默认边界取到最后一个完整事件（第二个 turn/end）；残迹那一行不进支线。
    const forked = forkSessionFile(path, undefined, join(dir, 'b.jsonl'), 'b')
    expect(sameEvents(forked.events, scan.events)).toBe(true)
    expect(forked.header.seedLength).toBe(scan.events.length)
    expect(forked.events.at(-1)?.type).toBe('turn/end')
    forked.file.close()
  })
})

describe('临时目录：确定性清理', () => {
  it('makeScratchDir 每次唯一；removeScratchDir 幂等删除', () => {
    const a = makeScratchDir('s13-test-')
    const b = makeScratchDir('s13-test-')
    expect(a).not.toBe(b)
    removeScratchDir(a)
    removeScratchDir(b)
    removeScratchDir(a) // 幂等：不存在不抛
    expect(() => scanFile(join(a, 's.jsonl'))).toThrow()
  })
})

/** 测试用会话头。 */
function header(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt: 0 }
}
