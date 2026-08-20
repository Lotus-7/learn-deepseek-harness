import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx } from './cordis'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { permissionPlugin } from './plugin-permission'
import { compactionPlugin } from './plugin-compaction'
import { loopPlugin } from './plugin-loop'
import { deterministicSummarize } from './compaction'
import { searchLogsTool, echoTool, type Tool } from './tools'
import { SkillError, type Skill } from './skill-service'
import { skillPlugin } from './skill-plugin'
import { skillTools } from './skill-tools'
import type { LoggedEvent } from './log'

/**
 * 本课新增行为的测试（一）：技能系统。复制前进的 s01–s11 测试原样在场，
 * 这里只钉六件事——加载后规程在派生历史（模型看得见 ⟺ 已落账）、附加工具
 * 加载前后名册差异且下一步请求即可见、未知名响亮报错、重复加载幂等、
 * 工具重名冲突报错、压缩不摘除规程。
 */

/** 无附加工具的极简技能（多数用例的目录项）。 */
const plainSkill: Skill = {
  name: 'plain',
  description: '测试用极简技能',
  instructions: '规程：先看再说。',
}

/** 带专属工具的技能：execute 是确定性的纯文本。 */
const armedSkill: Skill = {
  name: 'armed',
  description: '测试用带工具技能',
  instructions: '规程：用 probe 探路。',
  tools: [
    {
      name: 'probe',
      description: '探测工具',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => 'probe 完成',
    },
  ],
}

/**
 * 装配测试代理：技能清单 + 目录/加载工具 +（可选）压缩，权限全放行。
 * @param script - 剧本响应序列。
 * @param skills - 装配的技能清单。
 * @param extraTools - 名册里的其它工具。
 * @param compaction - 传入则挂压缩插件（阈值/窗口自定）。
 * @param modelCalls - 传入则记录每次模型请求看到的工具名册（副本）。
 */
function assemble(
  script: readonly ModelResponse[],
  skills: readonly Skill[],
  extraTools: Tool[] = [],
  compaction?: { threshold: number; keepTail: number },
  modelCalls?: string[][],
): Ctx {
  const ctx = new Ctx()
  const base = createMockModel([...script])
  const model =
    modelCalls === undefined
      ? base
      : async (...args: Parameters<typeof base>) => {
          modelCalls.push(args[1].map((schema) => schema.name))
          return base(...args)
        }
  ctx.mount(modelPlugin(model))
  ctx.mount(toolsSessionPlugin([...extraTools, ...skillTools(ctx)]))
  ctx.mount(permissionPlugin({ rules: { '*': 'allow' } }))
  if (compaction !== undefined) {
    ctx.mount(compactionPlugin({ ...compaction, summarize: deterministicSummarize }))
  }
  ctx.mount(skillPlugin(skills))
  ctx.mount(loopPlugin())
  return ctx
}

/** 取日志里全部 tool/result 的输出文本。 */
function resultTexts(events: readonly LoggedEvent[]): string[] {
  return events.filter((event) => event.type === 'tool/result').map((event) => event.output)
}

describe('加载：规程经 system/message 落账并进入派生历史', () => {
  it('加载后日志有 system/message 事件，派生历史有 system 规程（模型看得见 ⟺ 已落账）', async () => {
    const ctx = assemble(
      [
        {
          message: { role: 'assistant', content: null, tool_calls: [toolCall('l1', 'load_skill', { name: 'plain' })] },
          finishReason: 'tool_calls',
        },
        { message: { role: 'assistant', content: '已加载。' }, finishReason: 'stop' },
      ],
      [plainSkill],
    )
    await ctx.get('agent').run('加载 plain。')
    const log = ctx.get('sessions').log
    const injected = log.events.filter((event) => event.type === 'system/message')
    expect(injected).toHaveLength(1)
    expect(injected[0]).toMatchObject({ type: 'system/message', content: expect.stringContaining('[skill: plain]') })
    const systemMessages = log.deriveMessages().filter((message) => message.role === 'system')
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0]!.content).toContain('规程：先看再说。')
  })

  it('目录工具只给名与简介，不给规程全文', async () => {
    const ctx = assemble(
      [
        {
          message: { role: 'assistant', content: null, tool_calls: [toolCall('q1', 'list_skills', {})] },
          finishReason: 'tool_calls',
        },
        { message: { role: 'assistant', content: '知道了。' }, finishReason: 'stop' },
      ],
      [plainSkill],
    )
    await ctx.get('agent').run('有哪些技能？')
    expect(resultTexts(ctx.get('sessions').log.events)[0]).toContain('- plain：测试用极简技能')
    expect(resultTexts(ctx.get('sessions').log.events)[0]).not.toContain('规程：先看再说')
  })
})

describe('附加工具：加载前后名册差异，下一步请求即可见', () => {
  it('加载前名册与模型请求都没有 probe；加载后两者都有，且无需重装配', async () => {
    const seenRosters: string[][] = []
    const ctx = assemble(
      [
        {
          message: { role: 'assistant', content: null, tool_calls: [toolCall('a1', 'load_skill', { name: 'armed' })] },
          finishReason: 'tool_calls',
        },
        {
          message: { role: 'assistant', content: null, tool_calls: [toolCall('p1', 'probe', {})] },
          finishReason: 'tool_calls',
        },
        { message: { role: 'assistant', content: '完成。' }, finishReason: 'stop' },
      ],
      [armedSkill],
      [],
      undefined,
      seenRosters,
    )
    await ctx.get('agent').run('加载 armed 然后探测。')
    // 加载前（第一次请求）：名册里没有任何技能工具。
    expect(seenRosters[0]).not.toContain('probe')
    // 加载后：同一次装配的下一次模型请求就带着 probe（loop 每步重取 schema）。
    expect(seenRosters[1]).toContain('probe')
    const texts = resultTexts(ctx.get('sessions').log.events)
    expect(texts[0]).toContain('附带工具已注册进名册：probe')
    expect(texts[1]).toBe('probe 完成')
  })

  it('技能工具与名册现有工具重名 → SKILL_TOOL_CONFLICT 回喂（可恢复，循环不崩）', async () => {
    // 同名但不同对象：同名是冲突；同一对象才算本技能此前注册的（幂等）。
    const sameNameEcho: Tool = { ...echoTool, execute: echoTool.execute }
    const conflicting: Skill = {
      name: 'clash',
      description: '与现有名册重名的技能',
      instructions: '规程：冲突。',
      tools: [sameNameEcho],
    }
    const ctx = assemble(
      [
        {
          message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'load_skill', { name: 'clash' })] },
          finishReason: 'tool_calls',
        },
        { message: { role: 'assistant', content: '加载失败，换路。' }, finishReason: 'stop' },
      ],
      [conflicting],
      [echoTool],
    )
    await ctx.get('agent').run('加载 clash。')
    const texts = resultTexts(ctx.get('sessions').log.events)
    expect(texts[0]).toContain('SKILL_TOOL_CONFLICT')
    expect(texts[0]).toContain('与名册现有工具重名')
    expect(texts[0]).toContain('请检查装配清单或换用不带该工具的技能')
    // 冲突在注入前判定：失败的加载一条规程都不注入（零副作用）。
    expect(
      ctx.get('sessions').log.events.filter((event) => event.type === 'system/message'),
    ).toHaveLength(0)
    expect(ctx.get('sessions').log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' })
  })
})

describe('未知名与重复加载', () => {
  it('load_skill 未知名 → 响亮报错回喂（带可用名册与补救语）', async () => {
    const ctx = assemble(
      [
        {
          message: { role: 'assistant', content: null, tool_calls: [toolCall('u1', 'load_skill', { name: 'nope' })] },
          finishReason: 'tool_calls',
        },
        { message: { role: 'assistant', content: '名字错了。' }, finishReason: 'stop' },
      ],
      [plainSkill],
    )
    await ctx.get('agent').run('加载 nope。')
    const [denied] = resultTexts(ctx.get('sessions').log.events)
    expect(denied).toContain('没有叫 "nope" 的技能（SKILL_UNKNOWN；可用技能：plain）')
    expect(denied).toContain('请先用 list_skills 查看可用技能名册')
  })

  it('重复加载幂等：回喂「此前已加载」，日志仍只有一条 system/message', async () => {
    const load = (id: string): ModelResponse => ({
      message: { role: 'assistant', content: null, tool_calls: [toolCall(id, 'load_skill', { name: 'plain' })] },
      finishReason: 'tool_calls',
    })
    const ctx = assemble(
      [load('x1'), load('x2'), { message: { role: 'assistant', content: '完成。' }, finishReason: 'stop' }],
      [plainSkill],
    )
    await ctx.get('agent').run('加载两次 plain。')
    const texts = resultTexts(ctx.get('sessions').log.events)
    expect(texts[0]).toContain('已加载：规程已注入 system 段')
    expect(texts[1]).toContain('此前已加载，规程已在 system 段生效（幂等，不重复注入）')
    expect(
      ctx.get('sessions').log.events.filter((event) => event.type === 'system/message'),
    ).toHaveLength(1)
  })
})

describe('技能与压缩并存：规程不参与摘要', () => {
  it('低阈值触发压缩后，派生历史仍含 system 规程；摘要输入不含规程', async () => {
    const ctx = assemble(
      [
        {
          message: { role: 'assistant', content: null, tool_calls: [toolCall('l1', 'load_skill', { name: 'plain' })] },
          finishReason: 'tool_calls',
        },
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall('g1', 'search_logs', { query: 'cpu' })],
          },
          finishReason: 'tool_calls',
        },
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall('g2', 'search_logs', { query: 'mem' })],
          },
          finishReason: 'tool_calls',
        },
        { message: { role: 'assistant', content: '查完了。' }, finishReason: 'stop' },
      ],
      [plainSkill],
      [searchLogsTool],
      { threshold: 100, keepTail: 2 },
    )
    await ctx.get('agent').run('加载技能然后查两轮日志。')
    const log = ctx.get('sessions').log
    const compacted = log.events.filter((event) => event.type === 'session/compacted')
    expect(compacted.length).toBeGreaterThan(0)
    const derived = log.deriveMessages()
    const systemMessages = derived.filter((message) => message.role === 'system')
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0]!.content).toContain('[skill: plain]')
    expect(systemMessages[0]!.content).toContain('规程：先看再说。')
    // 摘要接管的是事实，不是规程：压缩事件的 summary 里不重复规程正文。
    const summary = (compacted.at(-1) as { summary: string }).summary
    expect(summary).not.toContain('规程：先看再说')
  })
})

describe('服务面直测：catalog 排序与 SkillError 语义', () => {
  it('catalog 按名排序；load 未知名抛 SkillError（code 面向程序）', () => {
    const ctx = assemble([], [armedSkill, plainSkill])
    const skills = ctx.get('skills')
    expect(skills.catalog().map((entry) => entry.name)).toEqual(['armed', 'plain'])
    expect(() => skills.load('ghost', ctx.get('sessions'))).toThrowError(SkillError)
    try {
      skills.load('ghost', ctx.get('sessions'))
    } catch (error) {
      expect((error as SkillError).code).toBe('SKILL_UNKNOWN')
    }
  })

  it('技能名重复注册是装配错误，插件挂载当场抛', () => {
    expect(() => new Ctx().mount(skillPlugin([plainSkill, plainSkill]))).toThrow('技能 "plain" 重复注册')
  })
})
