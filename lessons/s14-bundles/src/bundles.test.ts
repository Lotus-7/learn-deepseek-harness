import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx } from './cordis'
import { BASE, FULL_PROFILE, SAFE_PROFILE, layerOf, resolveBundle, type Layer, type Override } from './bundles'
import { assembleBundle, type AssembleRuntime } from './assemble'
import { createSandboxWorld } from './world-sandbox'
import type { LoggedEvent } from './log'

/**
 * 轻 rig：resolve → assemble → 跑一个 turn，返回事件流与审批记录。
 * 产品差异只经 layers（层叠数据）进来——rig 本身对所有产品是同一段代码，
 * 这正是「同一份插件代码」的测试面。
 */
async function rig(layers: readonly Layer[], script: readonly ModelResponse[], request: string) {
  const resolved = resolveBundle(BASE, layers)
  const approvals: string[] = []
  const world = createSandboxWorld()
  const runtime: AssembleRuntime = {
    model: createMockModel([...script]),
    world,
    askUser: async (question) => {
      approvals.push(question.tool)
      return 'allow'
    },
  }
  const ctx = assembleBundle(resolved, runtime)
  await ctx.get('agent').run(request)
  return { resolved, approvals, events: ctx.get('sessions').log.events, world, ctx }
}

/** 取某个 callId 的 tool/result 输出。 */
function resultOf(events: readonly LoggedEvent[], callId: string): string {
  const found = events.find((event) => event.type === 'tool/result' && event.callId === callId)
  if (found === undefined || found.type !== 'tool/result') throw new Error(`缺少 callId=${callId} 的 tool/result`)
  return found.output
}

/** 权限拒绝回喂的判定：deny 的 tool/result 以固定前缀开头（s04 的约定）。 */
function isDenied(output: string): boolean {
  return output.includes('权限拒绝：')
}

/** 事件流里 session/compacted 的条数（压缩是否触发、触发几次）。 */
function compactions(events: readonly LoggedEvent[]): number {
  return events.filter((event) => event.type === 'session/compacted').length
}

/** 同一请求、同一形态的三段剧本（full / safe / patched 各一套）。 */
const REQUEST = '把暗号「榴莲酥」写进 /sandbox/notes.md，然后用命令确认它在了。'
const WRITE_CALL = (id: string): ModelResponse => ({
  message: {
    role: 'assistant',
    content: null,
    tool_calls: [toolCall(id, 'write_file', { path: '/sandbox/notes.md', content: '暗号：榴莲酥' })],
  },
  finishReason: 'tool_calls',
})
const LIST_CALL = (id: string): ModelResponse => ({
  message: { role: 'assistant', content: null, tool_calls: [toolCall(id, 'list_dir', { path: '/sandbox' })] },
  finishReason: 'tool_calls',
})
const ANSWER = (content: string): ModelResponse => ({
  message: { role: 'assistant', content },
  finishReason: 'stop',
})
const RUN_CALL = (id: string): ModelResponse => ({
  message: {
    role: 'assistant',
    content: null,
    tool_calls: [toolCall(id, 'run_command', { command: 'cat', args: ['/sandbox/notes.md'] })],
  },
  finishReason: 'tool_calls',
})

describe('resolve：层叠与校验（misconfiguration fails loud，全部前置在挂载之前）', () => {
  it('profile 覆盖按 id 整体替换行——safe 的 permission 重述后，base 的默认 ask 不残留', () => {
    const safe = resolveBundle(BASE, [SAFE_PROFILE])
    expect(safe.permission.defaultDecision).toBe('deny')
    expect(safe.permission.rules['read_file']).toBe('allow')
    expect(safe.permission.rules['write_file']).toBe('deny')
    // 整体替换的另一面：full 的覆盖重述了全表，safe 的覆盖也重述了全表——
    // 两份 rules 都不与 base 的空表（默认 ask）合并出第三种东西。
    expect(Object.keys(safe.permission.rules)).toHaveLength(13)
  })

  it('未覆盖的行保留 base 的原对象——两个 profile 共享同一份底座声明（结构断言）', () => {
    const full = resolveBundle(BASE, [FULL_PROFILE])
    const safe = resolveBundle(BASE, [SAFE_PROFILE])
    for (const id of ['model', 'world', 'subagent', 'skill', 'workflow', 'loop'] as const) {
      const inFull = full.entries.find((entry) => entry.id === id)
      const inSafe = safe.entries.find((entry) => entry.id === id)
      expect(inFull).toBe(inSafe)
    }
    // full 未覆盖 compaction / tools：与 base 同一对象。
    expect(full.entries.find((entry) => entry.id === 'compaction')).toBe(
      BASE.find((entry) => entry.id === 'compaction'),
    )
    expect(full.entries.find((entry) => entry.id === 'tools')).toBe(BASE.find((entry) => entry.id === 'tools'))
  })

  it('层序后写胜：patch 的同 id 覆盖压过 profile', () => {
    const unlock: Override = {
      id: 'permission',
      plugin: 'permission',
      rules: {
        echo: 'allow',
        add: 'allow',
        read_file: 'allow',
        list_dir: 'allow',
        search_logs: 'allow',
        fetch_stats: 'allow',
        cached_stats: 'allow',
        slow_scan: 'allow',
        list_skills: 'allow',
        load_skill: 'allow',
        write_file: 'ask',
        run_command: 'deny',
        delete_file: 'deny',
      },
      defaultDecision: 'deny',
      remember: false,
    }
    const patched = resolveBundle(BASE, [SAFE_PROFILE, { name: 'patch/x', overrides: [unlock] }])
    expect(patched.permission.rules['write_file']).toBe('ask')
    expect(patched.permission.rules['run_command']).toBe('deny')
  })

  it('错引响亮报错：覆盖 base 里不存在的行 id（错误信息列出可用行）', () => {
    const layer: Layer = { name: 'typo', overrides: [{ id: 'permisson', plugin: 'permission', rules: {}, defaultDecision: 'deny', remember: false }] }
    expect(() => resolveBundle(BASE, [layer])).toThrow(/"typo".*"permisson".*permission/)
  })

  it('错引响亮报错：覆盖的 plugin 与目标行不符（覆盖是重述，不是换插件）', () => {
    const layer: Layer = { name: 'mix', overrides: [{ id: 'compaction', plugin: 'permission', rules: {}, defaultDecision: 'deny', remember: false }] }
    expect(() => resolveBundle(BASE, [layer])).toThrow(/"mix".*compaction.*permission/)
  })

  it('错引响亮报错：名册点名目录里没有的工具', () => {
    const layer: Layer = {
      name: 'ghost-tool',
      overrides: [{ id: 'tools', plugin: 'tools', tools: ['read_file', 'rite_file'] }],
    }
    expect(() => resolveBundle(BASE, [layer])).toThrow(/rite_file/)
  })

  it('错引响亮报错：权限规则点名名册外的工具', () => {
    // safe 的名册没有 move_to_trash，却给它留了一条规则——管不着名册外的工具。
    const layer: Layer = {
      name: 'ghost-rule',
      overrides: [
        { id: 'permission', plugin: 'permission', rules: { read_file: 'allow', move_to_trash: 'deny' }, defaultDecision: 'deny', remember: false },
      ],
    }
    expect(() => resolveBundle(BASE, [SAFE_PROFILE, layer])).toThrow(/move_to_trash/)
  })

  it('压缩配置校验：非正阈值与非法尾部窗口报错', () => {
    const badThreshold: Layer = { name: 't', overrides: [{ id: 'compaction', plugin: 'compaction', threshold: 0, keepTail: 4 }] }
    expect(() => resolveBundle(BASE, [badThreshold])).toThrow(/阈值/)
    const badTail: Layer = { name: 'k', overrides: [{ id: 'compaction', plugin: 'compaction', threshold: 700, keepTail: 0 }] }
    expect(() => resolveBundle(BASE, [badTail])).toThrow(/尾部窗口/)
  })

  it('校验前置在挂载之前：resolve 抛错时一个插件都没构造', () => {
    const layer: Layer = { name: 'bad', overrides: [{ id: 'nope', plugin: 'model' }] }
    expect(() => resolveBundle(BASE, [layer])).toThrow()
  })
})

describe('full 与 safe：同一剧本，两种结局', () => {
  it('full：写与跑命令经 ask 批准通过，文件真的落进世界', async () => {
    const run = await rig(
      [FULL_PROFILE],
      [WRITE_CALL('f1'), RUN_CALL('f2'), ANSWER('写入并用 cat 确认了。')],
      REQUEST,
    )
    expect(run.approvals).toEqual(['write_file', 'run_command'])
    expect(isDenied(resultOf(run.events, 'f1'))).toBe(false)
    expect(resultOf(run.events, 'f2')).toContain('暗号：榴莲酥')
    await expect(run.world.readFile('/sandbox/notes.md')).resolves.toBe('暗号：榴莲酥')
  })

  it('safe：写被 deny 回喂，模型改走只读路径，世界零改动', async () => {
    const run = await rig(
      [SAFE_PROFILE],
      [WRITE_CALL('s1'), LIST_CALL('s2'), ANSWER('被拒，改走只读确认。')],
      REQUEST,
    )
    expect(run.approvals).toEqual([])
    expect(isDenied(resultOf(run.events, 's1'))).toBe(true)
    expect(resultOf(run.events, 's1')).toContain('write_file')
    expect(isDenied(resultOf(run.events, 's2'))).toBe(false)
    await expect(run.world.readFile('/sandbox/notes.md')).rejects.toThrow()
  })

  it('名册差异：safe 砍掉委派/后台/可恢复清理，保留 deny 在场的写/跑/删', async () => {
    const full = await rig([FULL_PROFILE], [ANSWER('好。')], '好。')
    const safe = await rig([SAFE_PROFILE], [ANSWER('好。')], '好。')
    // 用装配后名册（模型真实可见面）断言，而非只看数据表。
    const rosterOf = (ctx: Ctx): string[] => ctx.get('tools').registry.schemas().map((schema) => schema.name)
    const fullRoster = rosterOf(full.ctx)
    const safeRoster = rosterOf(safe.ctx)
    for (const cut of ['delegate', 'move_to_trash', 'start_job', 'collect_job']) {
      expect(fullRoster).toContain(cut)
      expect(safeRoster).not.toContain(cut)
    }
    for (const kept of ['write_file', 'run_command', 'delete_file', 'read_file', 'list_dir', 'search_logs']) {
      expect(safeRoster).toContain(kept)
    }
    expect(safeRoster).toHaveLength(fullRoster.length - 4)
  })

  it('两 profile 装配的插件列表一致——同一批插件组装出不同产品（结构断言）', async () => {
    const full = await rig([FULL_PROFILE], [ANSWER('好。')], '好。')
    const safe = await rig([SAFE_PROFILE], [ANSWER('好。')], '好。')
    expect(safe.ctx.plugins).toEqual(full.ctx.plugins)
  })

  it('profile 是纯数据：JSON 往返后 resolve 出同样的行表', () => {
    const direct = resolveBundle(BASE, [SAFE_PROFILE])
    const roundTripped = resolveBundle(BASE, [JSON.parse(JSON.stringify(layerOf(SAFE_PROFILE)))])
    expect(roundTripped.entries).toEqual(direct.entries)
    expect(roundTripped.roster).toEqual(direct.roster)
    expect(roundTripped.permission).toEqual(direct.permission)
  })
})

describe('patch：一行重述换策略', () => {
  /** 给 safe 解锁 write_file 的 patch（整行重述——run_command 的 deny 照抄）。 */
  const UNLOCK: Override = {
    id: 'permission',
    plugin: 'permission',
    rules: {
      echo: 'allow',
      add: 'allow',
      read_file: 'allow',
      list_dir: 'allow',
      search_logs: 'allow',
      fetch_stats: 'allow',
      cached_stats: 'allow',
      slow_scan: 'allow',
      list_skills: 'allow',
      load_skill: 'allow',
      write_file: 'ask',
      run_command: 'deny',
      delete_file: 'deny',
    },
    defaultDecision: 'deny',
    remember: false,
  }

  it('解锁方向：safe + patch 后同一剧本翻转——写经 ask 批准通过，跑仍被拒', async () => {
    const run = await rig(
      [SAFE_PROFILE, { name: 'patch/unlock-write', overrides: [UNLOCK] }],
      [WRITE_CALL('p1'), RUN_CALL('p2'), LIST_CALL('p3'), ANSWER('写入批准，跑被拒，列目录确认。')],
      REQUEST,
    )
    expect(run.approvals).toEqual(['write_file'])
    expect(isDenied(resultOf(run.events, 'p1'))).toBe(false)
    expect(isDenied(resultOf(run.events, 'p2'))).toBe(true)
    await expect(run.world.readFile('/sandbox/notes.md')).resolves.toBe('暗号：榴莲酥')
  })

  it('收紧方向：full + patch 把 write_file 改 deny——同一剧本翻转回拒绝', async () => {
    // full 的规则表整行重述，唯 write_file 换 deny——收紧与放松是同一种操作。
    const tighten: Override = {
      id: 'permission',
      plugin: 'permission',
      rules: {
        echo: 'allow',
        add: 'allow',
        read_file: 'allow',
        list_dir: 'allow',
        search_logs: 'allow',
        fetch_stats: 'allow',
        cached_stats: 'allow',
        slow_scan: 'allow',
        list_skills: 'allow',
        load_skill: 'allow',
        write_file: 'deny',
        run_command: 'ask',
        delete_file: 'ask',
        move_to_trash: 'ask',
        delegate: 'ask',
        start_job: 'ask',
        collect_job: 'ask',
      },
      defaultDecision: 'ask',
      remember: true,
    }
    const run = await rig(
      [FULL_PROFILE, { name: 'patch/lock-write', overrides: [tighten] }],
      [WRITE_CALL('t1'), LIST_CALL('t2'), ANSWER('本部署禁写，只读确认。')],
      REQUEST,
    )
    expect(run.approvals).toEqual([])
    expect(isDenied(resultOf(run.events, 't1'))).toBe(true)
    expect(isDenied(resultOf(run.events, 't2'))).toBe(false)
  })

  it('压缩阈值也能一行换：patch 调低 full 阈值前不压缩、调低后压缩；safe 本来就更早压', async () => {
    // 三轮检索:第 4 个步骤边界时派生历史约 800 token(safe 阈值 380 触发压缩,
    // 头部 3 条约 280 token,摘要比它小——压缩成立;full 阈值 1200 不触发)。
    // 两轮不够:头部只剩 1 条 user 消息,「摘要必须比被压头部小」的约定会让
    // 压缩静默放弃(maybeCompact 的放弃条件③)。
    const longScript: ModelResponse[] = [
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'search_logs', { query: 'latency' })] },
        finishReason: 'tool_calls',
      },
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('c2', 'search_logs', { query: 'status' })] },
        finishReason: 'tool_calls',
      },
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('c3', 'search_logs', { query: 'timeout' })] },
        finishReason: 'tool_calls',
      },
      ANSWER('三轮检索完成。'),
    ]
    const full = await rig([FULL_PROFILE], longScript, '连续检索三轮日志。')
    expect(compactions(full.events)).toBe(0)
    const safe = await rig([SAFE_PROFILE], longScript, '连续检索三轮日志。')
    expect(compactions(safe.events)).toBeGreaterThan(0)
    const lower: Override = { id: 'compaction', plugin: 'compaction', threshold: 380, keepTail: 4 }
    const patched = await rig([FULL_PROFILE, { name: 'patch/early-compact', overrides: [lower] }], longScript, '连续检索三轮日志。')
    expect(compactions(patched.events)).toBeGreaterThan(0)
    expect(patched.resolved.layers).toEqual(['base', 'full', 'patch/early-compact'])
  })
})
