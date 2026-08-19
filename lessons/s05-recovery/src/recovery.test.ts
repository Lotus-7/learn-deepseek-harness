import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type Model, type ModelResponse } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { registryOf } from './registry'
import { SessionLog } from './log'
import { cachedStatsTool, echoTool, fetchStatsTool, slowScanTool } from './tools'

const recoveryRegistry = () => registryOf(echoTool, slowScanTool, fetchStatsTool, cachedStatsTool)

/** 挂起中的 slow_scan 请求：第一幕演示同款剧本的第一步。 */
const scanStep: ModelResponse = {
  message: {
    role: 'assistant',
    content: null,
    tool_calls: [toolCall('scan_1', 'slow_scan', { scope: '工作区' })],
  },
  finishReason: 'tool_calls',
}

/** 40ms 后以给定原因 abort 的控制器：演示同款「外部取消」。 */
function abortAfter(ms: number, reason: string): AbortController {
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error(reason)), ms)
  return controller
}

describe('取消：AbortSignal 贯穿', () => {
  it('挂起中的工具被 abort：日志收口为 turn/end(aborted) 且不再有后续事件', async () => {
    const model = createMockModel([scanStep])
    const log = new SessionLog()
    const messages = await runLoop(model, recoveryRegistry(), '全盘扫描', {
      log,
      signal: abortAfter(40, '超时预算用尽').signal,
    })
    expect(log.events.map((event) => event.type)).toEqual([
      'turn/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'turn/end',
    ])
    const end = log.events.at(-1)
    expect(end).toMatchObject({ type: 'turn/end', reason: 'aborted' })
    // 取消不是异常：runLoop 正常返回截至取消的派生历史（最后一条不是回答）
    expect(messages).toEqual(log.deriveMessages())
    // 收口即终点：再等一个时间片，日志不再增长（没有迟到的 tool/result 或第二条 turn/end）
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'aborted' })
    expect(log.events).toHaveLength(5)
  })

  it('工具体监听 signal 才能被中途打断：slow_scan 以取消原因落定', async () => {
    // 挂起工具在 abort 时 reject 取消原因——错误文本不上日志（tool/result 不落账），
    // 但原因能在 catch 里被调用方读到（真产品里这是给 UI 的「为什么停了」）。
    const reason = '用户等不及了'
    const controller = abortAfter(40, reason)
    const caught: unknown = await slowScanTool.execute({ scope: 'x' }, controller.signal).catch((error: unknown) => error)
    expect((caught as Error).message).toBe(reason)
  })

  it('取消发生在步骤边界（工具完成后、下一次模型请求前）：同样收口，已完成的结果在账上', async () => {
    const model = createMockModel([
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('e1', 'echo', { text: '先干一步' })] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: '不该走到这里' }, finishReason: 'stop' },
    ])
    const controller = new AbortController()
    const log = new SessionLog()
    // echo 完成后、第二次模型调用前触发取消——步骤边界检查点接住它
    const messages = await runLoop(model, recoveryRegistry(), '干一步然后停', {
      log,
      signal: controller.signal,
      postExecute: [() => controller.abort(new Error('第二步前取消'))],
    })
    expect(log.events.map((event) => event.type)).toEqual([
      'turn/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result', // 已完成的工作在账上
      'turn/end',
    ])
    expect(log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'aborted' })
    // 模型只被调用过一次：取消后的检查点没有发出第二次请求
    expect(model.calls).toHaveLength(1)
    expect(messages.at(-1)).toMatchObject({ role: 'tool', content: '先干一步' })
  })

  it('进入循环前已 abort：不调模型，立即收口', async () => {
    const model = createMockModel([{ message: { role: 'assistant', content: '不该出现' }, finishReason: 'stop' }])
    const controller = new AbortController()
    controller.abort(new Error('进门前就取消了'))
    const log = new SessionLog()
    await runLoop(model, recoveryRegistry(), '来不及的任务', { log, signal: controller.signal })
    expect(log.events.map((event) => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'aborted' })
    expect(model.calls).toHaveLength(0)
  })

  it('取消收口后日志是闭合的：fork 可用（干净收尾是可恢复的前提）', async () => {
    const model = createMockModel([scanStep])
    const log = new SessionLog()
    await runLoop(model, recoveryRegistry(), '全盘扫描', { log, signal: abortAfter(40, '超时').signal })
    // 对照 s04：maxSteps 留下未闭合 turn，fork 拒绝；取消收口的 turn 可以分叉续写
    const child = log.fork()
    expect(child.events).toHaveLength(log.events.length)
    // 分叉后换一个新 signal 继续对话——被取消的会话不是废墟
    const followUp = createMockModel([{ message: { role: 'assistant', content: '从上次的断点继续。' }, finishReason: 'stop' }])
    await runLoop(followUp, recoveryRegistry(), '换个思路继续', { log, signal: new AbortController().signal })
    expect(log.nextTurn()).toBe(3)
  })

  it('保险丝熔断不被并发的取消吞掉：abort 落在最后一步执行期间，maxSteps 错误仍上抛', async () => {
    // 竞态构造：maxSteps: 1 的最后一步里，abort 在 preExecute 守卫间隙触发，
    // 工具本体（echo）不理会 signal、照常完成——tool/result 落账后循环恰好耗尽。
    // 保险丝的熔断错误必须原样上抛、turn 保持未闭合，不许被 catch 的取消
    // 改写吞成 turn/end(aborted)（fuse 的 throw 在 try/catch 之外）。
    const model = createMockModel([
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('last_1', 'echo', { text: '最后一步' })] },
        finishReason: 'tool_calls',
      },
    ])
    const controller = new AbortController()
    const log = new SessionLog()
    await expect(
      runLoop(model, recoveryRegistry(), '停不下来的活', {
        log,
        maxSteps: 1,
        signal: controller.signal,
        preExecute: [
          () => {
            controller.abort(new Error('执行期间被外部取消'))
            return undefined
          },
        ],
      }),
    ).rejects.toThrow(/maxSteps/)
    // 已完成的工作在账上，但没有任何 turn/end——是异常中止，不是取消收口
    expect(log.events.map((event) => event.type)).toEqual([
      'turn/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
    ])
    // 未闭合的 turn 不是合法的 fork 起点：保险丝的语义没有被取消竞态改写
    expect(() => log.fork()).toThrow(/未闭合的 turn/)
  })
})

describe('工具错误：可恢复的对话事实', () => {
  const statsScript: ModelResponse[] = [
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('s1', 'fetch_stats', { source: 'live' })] },
      finishReason: 'tool_calls',
    },
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('s2', 'cached_stats', {})] },
      finishReason: 'tool_calls',
    },
    { message: { role: 'assistant', content: '拿到缓存统计，任务完成。' }, finishReason: 'stop' },
  ]

  it('execute 抛错回喂模型：下一次请求包含错误文本，循环不崩', async () => {
    const model = createMockModel(statsScript)
    const log = new SessionLog()
    const messages = await runLoop(model, recoveryRegistry(), '看构建统计', { log })
    expect(model.calls[1]).toContainEqual({
      role: 'tool',
      content: '工具执行出错：上游统计服务返回 500，暂时不可用',
      tool_call_id: 's1',
    })
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: '拿到缓存统计，任务完成。' })
    expect(log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' })
  })

  it('错误回喂遵守宪法：第二次请求等于「截至该次调用前」日志前缀的投影', async () => {
    const model = createMockModel(statsScript)
    const log = new SessionLog()
    await runLoop(model, recoveryRegistry(), '看构建统计', { log })
    // 第二次模型请求发出于 seq=4（错误 tool/result 落账）之后、seq=5（第二条 assistant/message）之前
    const prefix = SessionLog.replay(log.events.slice(0, 5)).deriveMessages()
    expect(model.calls[1]).toEqual(prefix)
  })
})

describe('模型层错误：致命的进程级事件', () => {
  it('适配器抛错：收口 turn/end(error) 后原样上抛', async () => {
    const broken: Model = async () => {
      throw new Error('DeepSeek API 连接失败（模拟）')
    }
    const log = new SessionLog()
    await expect(runLoop(broken, recoveryRegistry(), '随便干点什么', { log })).rejects.toThrow(/连接失败/)
    expect(log.events.map((event) => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'error' })
  })

  it('error 收口与 abort 竞态时先定的结局不改写：至多一条 turn/end', async () => {
    // 模型抛错的同时 signal 也已触发：error 已收口，aborted 不再补写
    const controller = new AbortController()
    const broken: Model = async () => {
      controller.abort(new Error('迟到的取消'))
      throw new Error('API 500')
    }
    const log = new SessionLog()
    await expect(
      runLoop(broken, recoveryRegistry(), '竞态', { log, signal: controller.signal }),
    ).rejects.toThrow(/API 500/)
    const ends = log.events.filter((event) => event.type === 'turn/end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ reason: 'error' })
  })
})
