import { describe, expect, it, vi } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { createPermissionGuard, type AskQuestion } from './permission'
import { executeToolCall } from './pipeline'
import { registryOf } from './registry'
import { runLoop } from './agent'
import { SessionLog } from './log'
import { defineTool, deleteFileTool, moveToTrashTool, readFileTool } from './tools'

/** 现场定义一个「执行了就留痕」的工具：断言 execute 没被碰到时用它。 */
const probeTool = defineTool({
  name: 'probe',
  description: '测试探针',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'probe 执行了',
})

const registry = registryOf(readFileTool, moveToTrashTool, deleteFileTool, probeTool)

/** 剧本化假用户：按顺序吐出预设回答，记录收到的问题。 */
function scriptedUser(answers: ('allow' | 'deny')[]): {
  ask: (question: AskQuestion) => Promise<'allow' | 'deny'>
  questions: AskQuestion[]
} {
  const questions: AskQuestion[] = []
  return {
    questions,
    ask: async (question) => {
      questions.push(question)
      const answer = answers[questions.length - 1]
      if (answer === undefined) throw new Error('剧本假用户的回答耗尽')
      return answer
    },
  }
}

describe('createPermissionGuard：五条决策路径', () => {
  it('deny 规则直接否决并回喂，工具体不执行', async () => {
    const ask = vi.fn()
    const guard = createPermissionGuard({ rules: { probe: 'deny' }, askUser: ask })
    const record = await executeToolCall(registry, toolCall('c1', 'probe', {}), { preExecute: [guard] })
    expect(record.isError).toBe(true)
    expect(record.output).toBe('守卫否决：权限拒绝：策略把 probe 标记为 deny；如需完成目标，请改用其他工具')
    expect(ask).not.toHaveBeenCalled()
  })

  it('ask → 假用户拒绝：拒绝原因回喂，工具体不执行', async () => {
    const user = scriptedUser(['deny'])
    const guard = createPermissionGuard({ rules: { probe: 'ask' }, askUser: user.ask })
    const record = await executeToolCall(registry, toolCall('c1', 'probe', {}), { preExecute: [guard] })
    expect(record.isError).toBe(true)
    expect(record.output).toContain('权限拒绝：规则 probe → ask，用户拒绝了 probe 的执行')
    expect(user.questions).toHaveLength(1)
    expect(user.questions[0]).toMatchObject({ tool: 'probe', args: {} })
  })

  it('ask → 假用户允许：放行并执行成功', async () => {
    const user = scriptedUser(['allow'])
    const guard = createPermissionGuard({ rules: { probe: 'ask' }, askUser: user.ask })
    const record = await executeToolCall(registry, toolCall('c1', 'probe', {}), { preExecute: [guard] })
    expect(record.isError).toBe(false)
    expect(record.output).toBe('probe 执行了')
  })

  it('allow 规则直通：不问人，直接执行', async () => {
    const ask = vi.fn()
    const guard = createPermissionGuard({ rules: { read_file: 'allow' }, askUser: ask })
    const record = await executeToolCall(
      registry,
      toolCall('c1', 'read_file', { path: 'a.txt' }),
      { preExecute: [guard] },
    )
    expect(record.isError).toBe(false)
    expect(record.output).toContain('a.txt')
    expect(ask).not.toHaveBeenCalled()
  })

  it('通配 *：未列名的工具按通配决策处理', async () => {
    const guard = createPermissionGuard({ rules: { '*': 'deny' } })
    const record = await executeToolCall(registry, toolCall('c1', 'probe', {}), { preExecute: [guard] })
    expect(record.isError).toBe(true)
    expect(record.output).toBe('守卫否决：权限拒绝：策略把 probe 标记为 deny；如需完成目标，请改用其他工具')
  })
})

describe('createPermissionGuard：fail-safe 约定', () => {
  it('策略未匹配时默认 ask：交给人，而不是默默放行或挡死', async () => {
    const user = scriptedUser(['allow'])
    const guard = createPermissionGuard({ rules: {}, askUser: user.ask })
    const record = await executeToolCall(registry, toolCall('c1', 'probe', {}), { preExecute: [guard] })
    expect(record.isError).toBe(false)
    expect(record.output).toBe('probe 执行了')
    expect(guard.trace[0]).toMatchObject({ tool: 'probe', outcome: 'allow', via: 'ask-allowed' })
  })

  it('默认 ask 但没有审批通道：fail-safe 按拒绝处理（无头环境不许猜用户意图）', async () => {
    const guard = createPermissionGuard()
    const record = await executeToolCall(registry, toolCall('c1', 'probe', {}), { preExecute: [guard] })
    expect(record.isError).toBe(true)
    expect(record.output).toBe(
      '守卫否决：权限拒绝：probe 需要用户审批，但没有可用的审批通道（fail-safe，按拒绝处理）',
    )
  })

  it('显式 defaultDecision: deny 覆盖默认：未匹配直接拒', async () => {
    const ask = vi.fn()
    const guard = createPermissionGuard({ defaultDecision: 'deny', askUser: ask })
    const record = await executeToolCall(registry, toolCall('c1', 'probe', {}), { preExecute: [guard] })
    expect(record.isError).toBe(true)
    expect(record.output).toContain('权限拒绝：未匹配任何规则，默认 deny，按拒绝处理')
    expect(ask).not.toHaveBeenCalled()
  })

  it('审批通道抛错：问题失败在关着的一侧，按拒绝处理', async () => {
    const guard = createPermissionGuard({
      rules: { probe: 'ask' },
      askUser: async () => {
        throw new Error('UI 崩了')
      },
    })
    const record = await executeToolCall(registry, toolCall('c1', 'probe', {}), { preExecute: [guard] })
    expect(record.isError).toBe(true)
    expect(record.output).toBe('守卫否决：权限拒绝：审批通道出错（UI 崩了），按拒绝处理')
  })
})

describe('createPermissionGuard：会话记忆（可选缓存）', () => {
  it('缺省逐次裁决：同工具第二次 ask 仍然问人（one-shot，对齐 dsh 的 allowed-once）', async () => {
    const user = scriptedUser(['allow', 'allow'])
    const guard = createPermissionGuard({ rules: { probe: 'ask' }, askUser: user.ask })
    await executeToolCall(registry, toolCall('c1', 'probe', {}), { preExecute: [guard] })
    await executeToolCall(registry, toolCall('c2', 'probe', {}), { preExecute: [guard] })
    expect(user.questions).toHaveLength(2)
    expect(guard.trace.map((entry) => entry.via)).toEqual(['ask-allowed', 'ask-allowed'])
  })

  it("remember: true 时同一工具记住首次裁决：允许后不再问", async () => {
    const user = scriptedUser(['allow'])
    const guard = createPermissionGuard({ rules: { probe: 'ask' }, askUser: user.ask, remember: true })
    const first = await executeToolCall(registry, toolCall('c1', 'probe', {}), { preExecute: [guard] })
    const second = await executeToolCall(registry, toolCall('c2', 'probe', {}), { preExecute: [guard] })
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    expect(user.questions).toHaveLength(1)
    expect(guard.trace.map((entry) => entry.via)).toEqual(['ask-allowed', 'cache'])
  })

  it("remember: true 时记住的拒绝同样复用：第二次直接否决且不问人", async () => {
    const user = scriptedUser(['deny'])
    const guard = createPermissionGuard({ rules: { probe: 'ask' }, askUser: user.ask, remember: true })
    await executeToolCall(registry, toolCall('c1', 'probe', {}), { preExecute: [guard] })
    const second = await executeToolCall(registry, toolCall('c2', 'probe', {}), { preExecute: [guard] })
    expect(second.isError).toBe(true)
    expect(second.output).toContain('本会话已记住 probe 的裁决（拒绝）')
    expect(user.questions).toHaveLength(1)
  })
})

describe('runLoop × 权限守卫', () => {
  /** 演示同款剧本：读文件（allow）→ 删除被拒（ask → deny）→ 改道回收站（allow）→ 回答。 */
  const script: ModelResponse[] = [
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'read_file', { path: 'a.txt' })] },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('call_2', 'delete_file', { path: 'a.txt', force: true })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('call_3', 'move_to_trash', { path: 'a.txt' })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: { role: 'assistant', content: '已改用回收站完成清理。' },
      finishReason: 'stop',
    },
  ]
  const demoGuard = () =>
    createPermissionGuard({
      rules: {
        read_file: 'allow',
        move_to_trash: 'allow',
        delete_file: 'ask',
      },
      askUser: async () => 'deny', // 剧本：用户不放行删除
    })

  it('权限拒绝作为 tool 结果回喂模型，模型看得见并能改道', async () => {
    const model = createMockModel(script)
    const messages = await runLoop(model, registry, '帮我清理 a.txt', { preExecute: [demoGuard()] })
    expect(model.calls[2]).toContainEqual({
      role: 'tool',
      content:
        '守卫否决：权限拒绝：规则 delete_file → ask，用户拒绝了 delete_file 的执行；请改用允许清单内的工具完成目标',
      tool_call_id: 'call_2',
    })
    expect(model.calls[3]).toContainEqual({
      role: 'tool',
      content: '已把 a.txt 移入回收站（可随时恢复）',
      tool_call_id: 'call_3',
    })
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: '已改用回收站完成清理。' })
  })

  it('权限拒绝以 tool/result 落会话日志：拒绝也是模型可见事实', async () => {
    const model = createMockModel(script)
    const log = new SessionLog()
    await runLoop(model, registry, '帮我清理 a.txt', { log, preExecute: [demoGuard()] })
    const denial = log.events.find(
      (event) => event.type === 'tool/result' && event.callId === 'call_2',
    )
    expect(denial).toMatchObject({ type: 'tool/result', output: expect.stringContaining('权限拒绝：') })
  })
})
