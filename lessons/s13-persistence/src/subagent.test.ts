import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx } from './cordis'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { permissionPlugin } from './plugin-permission'
import { loopPlugin } from './plugin-loop'
import { fsTools } from './fs-tools'
import { worldPlugin } from './world-plugin'
import { createSandboxWorld } from './world-sandbox'
import type { ExecutionWorld } from './world-service'
import type { LoggedEvent } from './log'
import { createInProcessSubagentProvider } from './subagent-provider'
import { subagentPlugin } from './subagent-plugin'
import { delegateTool, type DelegateToolOptions } from './subagent-tools'
import { SubagentError, assertMaxDepth } from './subagent-service'

/**
 * 本课新增行为的测试：委派与隔离。复制前进的 s01–s10 测试原样在场
 * （agent/log/permission/recovery/cordis/plugins/fs-seam/world），这里只钉
 * 子代理 seam 的四件事：私有日志与父日志隔离、受限工具集响亮生效、
 * 深度上限拒绝回喂、委派结果回喂父后父能引用其内容——加装配防线。
 */

/** 预置两个报告文件的世界（每个用例各建一个，互不污染）。 */
async function seededWorld(): Promise<ExecutionWorld> {
  const world = createSandboxWorld()
  await world.writeFile('/sandbox/reports/alpha.md', '一\n二\n三\n')
  await world.writeFile('/sandbox/reports/beta.md', '四\n五\n六\n七\n八\n')
  return world
}

/**
 * 装配父代理（测试版）：fs 工具 + delegate，权限全放行——被测的是子代理
 * seam 的行为，不是权限层（s04/s10 已盖住）。
 * @param script - 剧本（父与子共用一个模型实例，按全局调用序编排）。
 * @param delegateOptions - delegate 工具的配置覆盖。
 * @param world - 共享的执行世界。
 */
function assemble(
  script: readonly ModelResponse[],
  delegateOptions: Partial<DelegateToolOptions>,
  world: ExecutionWorld,
): Ctx {
  const ctx = new Ctx()
  const delegate = delegateTool(ctx, { defaultTools: ['read_file', 'list_dir'], ...delegateOptions })
  ctx.mount(modelPlugin(createMockModel([...script])))
  ctx.mount(toolsSessionPlugin([...fsTools(ctx), delegate]))
  ctx.mount(permissionPlugin({ rules: { '*': 'allow' } }))
  ctx.mount(worldPlugin(world))
  ctx.mount(subagentPlugin(createInProcessSubagentProvider(ctx)))
  ctx.mount(loopPlugin())
  return ctx
}

/** 第一幕剧本：父委派 → 子列目录、读两个文件、汇总回答 → 父收结论。 */
function censusScript(): ModelResponse[] {
  return [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('p1', 'delegate', { task: '统计 /sandbox/reports 下所有文件的总行数' })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'list_dir', { path: '/sandbox/reports' })] },
      finishReason: 'tool_calls',
    },
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('c2', 'read_file', { path: '/sandbox/reports/alpha.md' })] },
      finishReason: 'tool_calls',
    },
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('c3', 'read_file', { path: '/sandbox/reports/beta.md' })] },
      finishReason: 'tool_calls',
    },
    { message: { role: 'assistant', content: '2 个文件合计 8 行（alpha 3 行、beta 5 行）。' }, finishReason: 'stop' },
    { message: { role: 'assistant', content: '子代理报告：reports 共 8 行。' }, finishReason: 'stop' },
  ]
}

/** 取日志里全部 tool/result 的输出文本（按落账顺序）。 */
function resultTexts(events: readonly LoggedEvent[]): string[] {
  return events.filter((event) => event.type === 'tool/result').map((event) => event.output)
}

describe('spawn 的结构化结果：answer 与委派开销', () => {
  it('outcome 从子日志折叠：回答、用过什么工具、多少事件多少轮', async () => {
    const world = await seededWorld()
    const script: ModelResponse[] = censusScript().slice(1, 5) // 只留子的四步
    const ctx = new Ctx()
    ctx.mount(modelPlugin(createMockModel([...script])))
    ctx.mount(toolsSessionPlugin([...fsTools(ctx)]))
    ctx.mount(worldPlugin(world))
    ctx.mount(subagentPlugin(createInProcessSubagentProvider(ctx)))
    const subagents = ctx.get('subagents')
    const toolset = ['read_file', 'list_dir'].map((name) => ctx.get('tools').registry.lookup(name))
    const handle = subagents.spawn({ task: '统计 /sandbox/reports 下所有文件的总行数', toolset })
    const outcome = await handle.result
    expect(outcome).toMatchObject({
      answer: '2 个文件合计 8 行（alpha 3 行、beta 5 行）。',
      stopReason: 'completed',
      toolsUsed: ['list_dir', 'read_file'],
      turns: 1,
    })
    expect(outcome.eventCount).toBe(13)
    // 子日志单独可查：logOf 与 handle.log 是同一份账本。
    expect(subagents.logOf(handle.id)).toBe(handle.log)
    // dispose 卸载子装配，日志对象仍然在场（审计不受生命周期影响）。
    handle.dispose()
    expect(subagents.logOf(handle.id).events).toHaveLength(13)
  })

  it('logOf 未知编号响亮报错（列出现存的）', () => {
    const ctx = new Ctx()
    ctx.mount(modelPlugin(createMockModel([])))
    ctx.mount(subagentPlugin(createInProcessSubagentProvider(ctx)))
    expect(() => ctx.get('subagents').logOf('sub-9')).toThrow('没有编号为 "sub-9" 的子代理')
  })
})

describe('隔离：子代理私有日志与父日志互不可见', () => {
  it('父日志只有 delegate 一对 tool 事件；子的任务与工具往返全在子日志', async () => {
    const world = await seededWorld()
    const ctx = assemble(censusScript(), {}, world)
    await ctx.get('agent').run('统计 reports。')
    const parent = ctx.get('sessions').log
    const parentCalls = parent.events.filter((event) => event.type === 'tool/call')
    expect(parentCalls.map((event) => (event as { name: string }).name)).toEqual(['delegate'])
    // 父日志不含子的 user/message（任务文本）与任何内部工具事件。
    const childTaskLeaked = parent.events.some(
      (event) => event.type === 'user/message' && event.content.includes('sandbox/reports 下所有文件'),
    )
    expect(childTaskLeaked).toBe(false)
    // 子日志：任务文本 + 三次工具往返 + 收口，完整可审计。
    const child = ctx.get('subagents').logOf('sub-1')
    expect(child.events.filter((event) => event.type === 'user/message')).toHaveLength(1)
    expect(child.events.filter((event) => event.type === 'tool/call')).toHaveLength(3)
    expect(child.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' })
    // 两个日志是不同的账本：事件不共享对象。
    expect(child).not.toBe(parent)
  })
})

describe('受限工具集：白名单外的调用响亮报错', () => {
  it('子调 write_file（默认白名单没有）→ 回喂带名册的错误 → 改道完成', async () => {
    const world = await seededWorld()
    const script: ModelResponse[] = [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [toolCall('p1', 'delegate', { task: '读取 alpha.md 并把结论记下来' })],
        },
        finishReason: 'tool_calls',
      },
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [toolCall('w1', 'write_file', { path: '/sandbox/summary.md', content: '8 行' })],
        },
        finishReason: 'tool_calls',
      },
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('r1', 'read_file', { path: '/sandbox/reports/alpha.md' })] },
        finishReason: 'tool_calls',
      },
      { message: { role: 'assistant', content: '没有写权限，我读了文件：3 行。' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: '子代理只能读：alpha 3 行。' }, finishReason: 'stop' },
    ]
    const ctx = assemble(script, {}, world)
    await ctx.get('agent').run('读文件并记录。')
    const childResults = resultTexts(ctx.get('subagents').logOf('sub-1').events)
    expect(childResults[0]).toContain('没有叫 "write_file" 的工具')
    // 名册本身就是断言：子的世界里只有白名单里的两个工具。
    expect(childResults[0]).toContain('当前名册：read_file, list_dir')
    expect(childResults[1]).toContain('一\n二\n三')
    expect(ctx.get('sessions').log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' })
  })
})

describe('深度上限：超限拒绝回喂，孙代理从未出生', () => {
  it('maxDepth=1：子可出生，子再委派被拒并回喂补救语，子改道完成', async () => {
    const world = await seededWorld()
    const script: ModelResponse[] = [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            toolCall('p1', 'delegate', { task: '统计 alpha.md 行数', tools: ['delegate', 'read_file'] }),
          ],
        },
        finishReason: 'tool_calls',
      },
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [toolCall('d1', 'delegate', { task: '再委派一层' })],
        },
        finishReason: 'tool_calls',
      },
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('r1', 'read_file', { path: '/sandbox/reports/alpha.md' })] },
        finishReason: 'tool_calls',
      },
      { message: { role: 'assistant', content: '被深度上限拦下后自己读了：3 行。' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: '子代理报告 3 行。' }, finishReason: 'stop' },
    ]
    const ctx = assemble(script, { maxDepth: 1 }, world)
    await ctx.get('agent').run('统计行数。')
    // 拒绝落在子自己的对话里：它看见带补救语的回喂，照常收口。
    const childResults = resultTexts(ctx.get('subagents').logOf('sub-1').events)
    expect(childResults[0]).toContain('子代理委派深度 2 超过上限 1（SUBAGENT_DEPTH_EXCEEDED）')
    expect(childResults[0]).toContain('请不再向下委派')
    expect(ctx.get('subagents').logOf('sub-1').events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' })
    // 孙从未出生：会话里只有 sub-1。
    expect(() => ctx.get('subagents').logOf('sub-2')).toThrow('没有编号为 "sub-2"')
  })

  it('直接 spawn 超深：provider 在启动之前抛 SubagentError（零副作用）', async () => {
    const world = await seededWorld()
    const ctx = assemble([], {}, world)
    expect(() => ctx.get('subagents').spawn({ task: 'x', toolset: [], depth: 2, maxDepth: 1 })).toThrow(SubagentError)
    // 拒绝发生在启动之前：没有子装配、没有子日志——会话里一个子代理都没有。
    expect(() => ctx.get('subagents').logOf('sub-1')).toThrow('没有编号为 "sub-1"')
  })

  it('maxDepth 域校验：负数/分数/NaN/字符串都拒，0 与正整数放行', () => {
    for (const bad of [-1, 1.5, Number.NaN, '2', Number.POSITIVE_INFINITY]) {
      expect(() => assertMaxDepth(bad)).toThrow(TypeError)
    }
    expect(() => assertMaxDepth(0)).not.toThrow()
    expect(() => assertMaxDepth(3)).not.toThrow()
  })
})

describe('委派结果回喂父：父能引用其内容', () => {
  it('delegate 的 tool/result 带子的回答与开销；父的最终回答引用子结论', async () => {
    const world = await seededWorld()
    const ctx = assemble(censusScript(), {}, world)
    await ctx.get('agent').run('统计 reports。')
    const [delegated] = resultTexts(ctx.get('sessions').log.events)
    expect(delegated).toContain('子代理 sub-1 已完成（委派开销：1 轮 / 13 个事件；使用工具 list_dir、read_file）')
    expect(delegated).toContain('子的最终回答：')
    expect(delegated).toContain('2 个文件合计 8 行')
    const parentAnswer = ctx.get('sessions').log.deriveMessages().at(-1)?.content ?? ''
    expect(parentAnswer).toContain('8 行')
  })
})

describe('装配防线：默认白名单不得含 delegate', () => {
  it('defaultTools 塞进 delegate → 构造期抛错（fail loud，不带病上岗）', () => {
    expect(() => delegateTool(new Ctx(), { defaultTools: ['read_file', 'delegate'] })).toThrow(
      '默认白名单不得包含自己',
    )
  })
})
