import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ChatMessage, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx, type Plugin } from './cordis'
import { runLoop } from './agent'
import { SessionLog } from './log'
import { createPermissionGuard, type PermissionOptions } from './permission'
import { deterministicSummarize, type CompactionOptions } from './compaction'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { permissionPlugin } from './plugin-permission'
import { compactionPlugin } from './plugin-compaction'
import { loopPlugin, type AgentService } from './plugin-loop'
import {
  addTool,
  cachedStatsTool,
  deleteFileTool,
  echoTool,
  fetchStatsTool,
  moveToTrashTool,
  readFileTool,
  searchLogsTool,
  slowScanTool,
  type Tool,
} from './tools'
import { registryOf } from './registry'

/** s06 演示同款九工具名册与权限规则、压缩策略——等价性对照的公共基准。 */
const S06_TOOLS: Tool[] = [
  addTool,
  echoTool,
  deleteFileTool,
  readFileTool,
  moveToTrashTool,
  slowScanTool,
  fetchStatsTool,
  cachedStatsTool,
  searchLogsTool,
]

const S06_PERMISSION: PermissionOptions = {
  rules: {
    read_file: 'allow',
    move_to_trash: 'allow',
    add: 'allow',
    echo: 'allow',
    delete_file: 'ask',
    slow_scan: 'allow',
    fetch_stats: 'allow',
    cached_stats: 'allow',
    search_logs: 'allow',
  },
}

const S06_COMPACTION: CompactionOptions = { threshold: 700, keepTail: 4, summarize: deterministicSummarize }

/** s06 演示的三幕剧本：两轮 search_logs 检索 + 深挖 + 引用早期事实的回答。 */
const SCRIPT: { responses: ModelResponse[]; userText: string }[] = [
  {
    userText: '我们的生产集群一共 47 台节点，最近超时报警很多。帮我从部署日志里分别查 timeout 和 restart 两种模式，给个初步判断。',
    responses: [
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'search_logs', { query: 'timeout' })] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'search_logs', { query: 'restart' })] }, finishReason: 'tool_calls' },
      {
        message: { role: 'assistant', content: '两种模式各命中 24 行。timeout 的延迟随 svc 编号走高，restart 集中在 svc-01，初步判断它过载引发级联重启。' },
        finishReason: 'stop',
      },
    ],
  },
  {
    userText: '继续深挖：再查一下 upstream_reset 的日志。',
    responses: [
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('t3', 'search_logs', { query: 'upstream_reset' })] }, finishReason: 'tool_calls' },
      {
        message: { role: 'assistant', content: 'upstream_reset 与 restart 的分布重合，判断坐实：上游依赖反复重置连接。建议对 svc-01 的上游做限流并观察 restart 曲线。' },
        finishReason: 'stop',
      },
    ],
  },
  {
    userText: '顺便确认一下：我们的集群一共多少台节点来着？',
    responses: [
      {
        message: { role: 'assistant', content: '我们的集群一共 47 台节点——这个数字来自开场的背景摘要，原文早已被压缩掉，但事实还在。' },
        finishReason: 'stop',
      },
    ],
  },
]

/** s06 形态的基线跑法：旧 runLoop + preExecute 数组 + compaction 参数。 */
async function runLegacyScript(): Promise<{ log: SessionLog; calls: ChatMessage[][] }> {
  const log = new SessionLog()
  const guard = createPermissionGuard(S06_PERMISSION)
  const registry = registryOf(...S06_TOOLS)
  const calls: ChatMessage[][] = []
  for (const turn of SCRIPT) {
    const model = createMockModel(turn.responses)
    await runLoop(model, registry, turn.userText, { log, preExecute: [guard], compaction: S06_COMPACTION })
    calls.push(...model.calls)
  }
  return { log, calls }
}

/** 装配任意插件组合并跑完三幕剧本。缺省为五件套全套（s06 等价配置）。 */
async function runPluginScript(
  replacements: { permission?: Plugin; compaction?: Plugin; omitCompaction?: boolean } = {},
): Promise<{ ctx: Ctx; agent: AgentService; log: SessionLog; calls: ChatMessage[][]; broadcast: string[] }> {
  const ctx = new Ctx()
  // 单一 mock 模型贯穿三 turn：按调用序回放，与 runLegacyScript 每turn各一个模型等价。
  const model = createMockModel(SCRIPT.flatMap((turn) => turn.responses))
  ctx.mount(modelPlugin(model))
  ctx.mount(toolsSessionPlugin(S06_TOOLS))
  ctx.mount(replacements.permission ?? permissionPlugin(S06_PERMISSION))
  if (!replacements.omitCompaction) ctx.mount(replacements.compaction ?? compactionPlugin(S06_COMPACTION))
  ctx.mount(loopPlugin())
  const agent = ctx.get('agent')
  const log = ctx.get('sessions').log
  const broadcast: string[] = []
  ctx.on('session/event', ({ event }) => broadcast.push(event.type))
  for (const turn of SCRIPT) await agent.run(turn.userText)
  return { ctx, agent, log, calls: model.calls, broadcast }
}

describe('五件套组装：与 s06 快照行为逐事件等价（重构不改行为）', () => {
  it('整份会话日志逐事件相等（含压缩事件的全部字段）', async () => {
    const [legacy, plugins] = await Promise.all([runLegacyScript(), runPluginScript()])
    expect(plugins.log.events).toEqual(legacy.log.events)
  })

  it('模型每次请求看到的消息完全一致（含压缩后的摘要视图）', async () => {
    const [legacy, plugins] = await Promise.all([runLegacyScript(), runPluginScript()])
    expect(plugins.calls).toEqual(legacy.calls)
  })

  it('压缩真的发生且最终回答引用早期事实（剧本自身的健康检查）', async () => {
    const { log } = await runPluginScript()
    expect(log.events.filter((event) => event.type === 'session/compacted')).toHaveLength(1)
    expect(log.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('47 台节点'),
    })
  })

  it('permission 守卫的裁决轨迹逐条符合 s04 规则语义（守卫代码零改动）', async () => {
    const permission = permissionPlugin(S06_PERMISSION)
    const ctx = new Ctx()
    ctx.mount(modelPlugin(createMockModel(SCRIPT.flatMap((turn) => turn.responses))))
    ctx.mount(toolsSessionPlugin(S06_TOOLS))
    ctx.mount(permission)
    ctx.mount(compactionPlugin(S06_COMPACTION))
    ctx.mount(loopPlugin())
    for (const turn of SCRIPT) await ctx.get('agent').run(turn.userText)
    expect(permission.guard.trace).toHaveLength(3)
    expect(permission.guard.trace.every((entry) => entry.tool === 'search_logs' && entry.outcome === 'allow' && entry.via === 'rule')).toBe(true)
  })
})

describe('换一个插件 = 换一个世界（其余代码零改动）', () => {
  it('换更严的 permission 插件：危险工具被拒、否决回喂、压缩不再触发', async () => {
    const strict = permissionPlugin({ rules: { '*': 'deny', read_file: 'allow' }, defaultDecision: 'deny' })
    const { log } = await runPluginScript({ permission: strict })
    const results = log.events.filter((event) => event.type === 'tool/result')
    expect(results).toHaveLength(3) // 三次 search_logs 全被拦
    for (const event of results) {
      if (event.type !== 'tool/result') continue
      expect(event.output).toMatch(/^守卫否决：权限拒绝：策略把 search_logs 标记为 deny/)
    }
    expect(strict.guard.trace).toHaveLength(3)
    expect(strict.guard.trace.every((entry) => entry.outcome === 'deny' && entry.via === 'rule')).toBe(true)
    // 历史被否决文本撑不满阈值：一次压缩都没有
    expect(log.events.filter((event) => event.type === 'session/compacted')).toHaveLength(0)
    expect(log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' })
  })

  it('换注入不同摘要器的 compaction 插件：压缩时机不变、摘要内容即变', async () => {
    const minimalSummarize = async (messages: readonly ChatMessage[]): Promise<string> =>
      `极简摘要：早期 ${messages.length} 条消息。`
    const { log, calls } = await runPluginScript({ compaction: compactionPlugin({ threshold: 700, keepTail: 4, summarize: minimalSummarize }) })
    const compacted = log.events.findLast((event) => event.type === 'session/compacted')
    expect(compacted).toMatchObject({ type: 'session/compacted', shadowedCount: 5 })
    if (compacted?.type !== 'session/compacted') throw new Error('unreachable：上面已断言存在')
    expect(compacted.summary).toContain('极简摘要')
    expect(compacted.summary).not.toContain('数字事实') // 确定性摘要器的标志内容不在了
    // 压缩后的下一次模型请求第一条就是新摘要（模型可见历史跟着变）
    const turnTwoSecondRequest = calls[4]
    expect(turnTwoSecondRequest?.[0]).toMatchObject({ role: 'user', content: expect.stringContaining('极简摘要') })
  })
})

describe('卸载插件：服务消失响亮报错，行为按插件回退（不静默空转）', () => {
  it('卸载 model 插件：run 响亮报错、日志零新增事件', async () => {
    const ctx = new Ctx()
    const unmountModel = ctx.mount(modelPlugin(createMockModel([])))
    ctx.mount(toolsSessionPlugin(S06_TOOLS))
    ctx.mount(permissionPlugin(S06_PERMISSION))
    ctx.mount(compactionPlugin(S06_COMPACTION))
    ctx.mount(loopPlugin())
    unmountModel()
    expect(ctx.plugins).toEqual(['tools-session', 'permission', 'compaction', 'loop'])
    await expect(ctx.get('agent').run('随便问点什么')).rejects.toThrow('没有叫 "model" 的服务')
    // 报错发生在第一个事实落账之前：日志一条都没写（不是空转半截 turn）
    expect(ctx.get('sessions').log.events).toHaveLength(0)
  })

  it('运行前卸载 compaction 插件：拦截器解绑，行为回到 s05（无压缩）', async () => {
    const ctx = new Ctx()
    ctx.mount(modelPlugin(createMockModel(SCRIPT.flatMap((turn) => turn.responses))))
    ctx.mount(toolsSessionPlugin(S06_TOOLS))
    ctx.mount(permissionPlugin(S06_PERMISSION))
    const unmountCompaction = ctx.mount(compactionPlugin(S06_COMPACTION))
    ctx.mount(loopPlugin())
    unmountCompaction()
    expect(ctx.plugins).toEqual(['model', 'tools-session', 'permission', 'loop'])
    for (const turn of SCRIPT) await ctx.get('agent').run(turn.userText)
    const log = ctx.get('sessions').log
    expect(log.events.filter((event) => event.type === 'session/compacted')).toHaveLength(0)
    expect(log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' })
  })

  it('不装 compaction 插件（四件套）：等价旧 runLoop 不传 compaction', async () => {
    const legacyLog = new SessionLog()
    const registry = registryOf(...S06_TOOLS)
    for (const turn of SCRIPT) {
      const model = createMockModel(turn.responses)
      await runLoop(model, registry, turn.userText, { log: legacyLog, preExecute: [createPermissionGuard(S06_PERMISSION)] })
    }
    const { log } = await runPluginScript({ omitCompaction: true })
    expect(log.events).toEqual(legacyLog.events)
  })
})

describe('ctx 事件协作：留痕与广播', () => {
  it('session/event 广播与日志逐条对齐（落账即广播，不漏不重）', async () => {
    const { log, broadcast } = await runPluginScript()
    expect(broadcast).toEqual(log.events.map((event) => event.type))
  })

  it('agent/step 每步广播一次（观察型第六插件的挂点）', async () => {
    const ctx = new Ctx()
    ctx.mount(modelPlugin(createMockModel(SCRIPT[0]!.responses)))
    ctx.mount(toolsSessionPlugin(S06_TOOLS))
    ctx.mount(permissionPlugin(S06_PERMISSION))
    ctx.mount(loopPlugin())
    const steps: string[] = []
    ctx.on('agent/step', ({ turn, step }) => steps.push(`${turn}-${step}`))
    await ctx.get('agent').run(SCRIPT[0]!.userText)
    expect(steps).toEqual(['1-1', '1-2', '1-3'])
  })
})
