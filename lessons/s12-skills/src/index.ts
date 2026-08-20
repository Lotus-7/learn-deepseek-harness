import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx } from './cordis'
import { deterministicSummarize } from './compaction'
import type { LoggedEvent, SessionLog } from './log'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { permissionPlugin } from './plugin-permission'
import { compactionPlugin } from './plugin-compaction'
import { loopPlugin } from './plugin-loop'
import { fsTools } from './fs-tools'
import {
  addTool,
  defineTool,
  echoTool,
  deleteFileTool,
  moveToTrashTool,
  slowScanTool,
  fetchStatsTool,
  cachedStatsTool,
  searchLogsTool,
  type Tool,
} from './tools'
import { worldPlugin } from './world-plugin'
import { worldTools } from './world-tools'
import { createSandboxWorld } from './world-sandbox'
import type { ExecutionWorld } from './world-service'
import { createInProcessSubagentProvider } from './subagent-provider'
import { subagentPlugin } from './subagent-plugin'
import { delegateTool } from './subagent-tools'
import type { Skill } from './skill-service'
import { skillPlugin } from './skill-plugin'
import { skillTools } from './skill-tools'
import type { JobDefinition } from './workflow-service'
import { workflowPlugin } from './workflow-plugin'
import { workflowTools } from './workflow-tools'

// —— s11 的世界与委派原样在场（统一执行世界、五件套、全部旧工具）；本课叠加
// 两块能力：技能系统（skill-service/-plugin/-tools：规程注入 + 附加工具）与
// 后台工作流（workflow-service/-plugin/-tools：start/collect 分离的异步取回）。

/** s11 复制前进的工具名册：旧工具照旧注册，fs / run_command / delegate 与本课的技能、工作流工具在装配处追加。 */
const BASE_TOOLS: Tool[] = [
  addTool,
  echoTool,
  deleteFileTool,
  moveToTrashTool,
  slowScanTool,
  fetchStatsTool,
  cachedStatsTool,
  searchLogsTool,
]

/** 本课权限规则：在 s11 基础上放行技能与工作流的四个工具。 */
const PERMISSION_RULES = {
  read_file: 'allow',
  write_file: 'allow',
  list_dir: 'allow',
  run_command: 'allow',
  delegate: 'allow',
  list_skills: 'allow',
  load_skill: 'allow',
  start_job: 'allow',
  collect_job: 'allow',
} as const

/**
 * csv 技能的专属工具：读文件、按 CSV 解析，报告列结构或单列汇总。
 * 「技能 = 规程 + 工具」里的那只手：规程要求「先用 csv_inspect 核对再谈统计」，
 * 这个工具就是核对动作本身——没有它，规程第 2/4 条只是空话。
 */
function csvInspectTool(ctx: Ctx): Tool {
  return defineTool({
    name: 'csv_inspect',
    description: '读取一个 CSV 文件并报告列结构（列名 + 数据行数），或指定 column 时给出该列的取值汇总',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要检查的 CSV 文件绝对路径' },
        column: { type: 'string', description: '要汇总的列名（缺省报告整体列结构）' },
      },
      required: ['path'],
    },
    execute: async (args) => {
      const content = await ctx.get('fs').readFile(String(args.path))
      const lines = content.split('\n').filter((line) => line.trim() !== '')
      const header = lines[0]!.split(',').map((name) => name.trim())
      const rows = lines.slice(1).map((line) => line.split(',').map((cell) => cell.trim()))
      if (args.column === undefined) {
        return `${String(args.path)}：${header.length} 列（${header.join('、')}），数据行 ${rows.length} 行（不含表头）`
      }
      const index = header.indexOf(String(args.column))
      if (index < 0) return `列 "${String(args.column)}" 不存在（实际列：${header.join('、')}）`
      const counts = new Map<string, number>()
      for (const row of rows) {
        const value = row[index] ?? ''
        counts.set(value, (counts.get(value) ?? 0) + 1)
      }
      const summary = [...counts.entries()].map(([value, count]) => `${value}×${count}`).join('、')
      return `列 ${String(args.column)} 的汇总（${rows.length} 行）：${summary}`
    },
  })
}

/**
 * csv 技能：规程 + 附加工具。instructions 规定处理规程；csv_inspect 随加载
 * 注册进名册（加载前模型调不到它——名册差异就是「技能带来工具」的证词）。
 */
function csvSkill(ctx: Ctx): Skill {
  return {
    name: 'csv',
    description: '结构化表格（CSV）数据的检查与统计规程',
    instructions: [
      '处理 CSV 数据时遵守以下规程：',
      '1. 先用 list_dir 确认数据文件清单，不要凭猜测读文件。',
      '2. 每个文件先用 csv_inspect 确认列结构与行数，再谈统计。',
      '3. 统计结论必须给出：总数据行数（写明「不含表头」的口径）与逐列汇总。',
      '4. 结论中不得出现未经 csv_inspect 核对的数字。',
    ].join('\n'),
    tools: [csvInspectTool(ctx)],
  }
}

/**
 * 后台工作流定义：给一个数据目录生成汇总报告。5 个进度步骤 + 1 个最终结果
 * ——步数是刻意的：主对话后续每件工具实事推进一步，第 5 步（collect 触发）
 * 时还差最后一步 → 第一次 collect 拿到 running，它的 tool/result 落账补上
 * 最后一拍 → 第二次 collect 拿到结果。「start/collect 分离」的两段体验全靠
 * 这份对齐（README「跑起来」逐拍解释）。
 */
function summaryReportWorkflow(ctx: Ctx): JobDefinition {
  return {
    kind: 'summary-report',
    description: '后台汇总一个数据目录：核对文件与行数，产出一段汇总报告文本',
    run: async function* (input: string) {
      const fs = ctx.get('fs')
      const entries = await fs.listDir(input)
      yield `读取数据目录清单：${entries.length} 个文件`
      const lineCounts: string[] = []
      let totalRows = 0
      for (const entry of entries) {
        const content = await fs.readFile(`${input}/${entry.name}`)
        const rows = content.split('\n').filter((line) => line.trim() !== '').length - 1
        totalRows += rows
        lineCounts.push(`${entry.name.replace('.csv', '')} ${rows} 行`)
      }
      yield `逐个文件核对行数：${lineCounts.join('、')}`
      const sales = await fs.readFile(`${input}/sales.csv`)
      const regionCounts = new Map<string, number>()
      for (const line of sales.split('\n').slice(1).filter((line) => line.trim() !== '')) {
        const region = line.split(',')[1]?.trim() ?? ''
        regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1)
      }
      const regions = [...regionCounts.entries()].map(([name, count]) => `${name}×${count}`).join('、')
      yield `汇总区域口径：${regions}`
      const amounts = sales
        .split('\n')
        .slice(1)
        .filter((line) => line.trim() !== '')
        .map((line) => Number(line.split(',')[2]))
      const totalAmount = amounts.reduce((sum, value) => sum + value, 0)
      yield '组装报告草稿（金额口径：amount 列求和）'
      yield '复核数字与格式'
      return `汇总报告：${input} 共 ${entries.length} 个数据文件、${totalRows} 个数据行（不含表头）；区域分布 ${regions}；金额合计 ${totalAmount}。`
    },
  }
}

/**
 * 装配：五件套 + 世界 + 子代理（s11 全在场）+ 本课的技能与工作流两块能力。
 * 权限面有个刻意的缺口：PERMISSION_RULES 是装配期静态表，**不预授权技能运行时
 * 带来的工具**（csv_inspect 不在表里）——技能扩的是模型的能力面，权限面要不要
 * 跟着扩是人（审批者）的决定。于是 csv_inspect 的首次调用落入默认 ask，
 * 经 askUser（剧本化的假用户，s04 语义）批准后由会话记忆（remember）放行后续
 * ——「技能扩权需要人点头」在演示里真实发生一次。
 * @param script - 剧本模型的响应序列。
 * @param world - 共享的执行世界。
 * @param approvals - askUser 的记录通道（演示收束段打印审批轨迹）。
 * @returns 装配好的 ctx。
 */
function assemble(script: readonly ModelResponse[], world: ExecutionWorld, approvals: string[]): Ctx {
  const ctx = new Ctx()
  const delegate = delegateTool(ctx, { defaultTools: ['read_file', 'list_dir'] })
  ctx.mount(modelPlugin(createMockModel([...script])))
  ctx.mount(
    toolsSessionPlugin([
      ...BASE_TOOLS,
      ...fsTools(ctx),
      ...worldTools(ctx),
      delegate,
      ...skillTools(ctx),
      ...workflowTools(ctx),
    ]),
  )
  ctx.mount(
    permissionPlugin({
      rules: { ...PERMISSION_RULES },
      askUser: async (question) => {
        // 剧本化审批（s04 的假用户）：记录后放行——收束段打印这条轨迹。
        approvals.push(`${question.tool}：${question.reason}`)
        return 'allow'
      },
      remember: true,
    }),
  )
  ctx.mount(compactionPlugin({ threshold: 700, keepTail: 4, summarize: deterministicSummarize }))
  ctx.mount(worldPlugin(world))
  ctx.mount(subagentPlugin(createInProcessSubagentProvider(ctx)))
  ctx.mount(skillPlugin([csvSkill(ctx)]))
  ctx.mount(workflowPlugin([summaryReportWorkflow(ctx)]))
  ctx.mount(loopPlugin())
  return ctx
}

/** 演示数据：两个 CSV（销售明细 + 区域负责人），规程的每一步都有实对象。 */
async function seedFiles(world: ExecutionWorld): Promise<void> {
  await world.writeFile(
    '/sandbox/data/sales.csv',
    `${['date,region,amount', '2026-08-01,north,120', '2026-08-01,south,200', '2026-08-02,north,80', '2026-08-02,east,150', '2026-08-03,south,60'].join('\n')}\n`,
  )
  await world.writeFile(
    '/sandbox/data/regions.csv',
    `${['region,owner', 'north,小七', 'south,阿九', 'east,老周'].join('\n')}\n`,
  )
}

/** 剧本：查目录 → 加载技能 → 挂后台 job → 按规程统计 → 两段式 collect → 收尾。 */
function script(): ModelResponse[] {
  return [
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('s1', 'list_skills', {})] },
      finishReason: 'tool_calls',
    },
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('s2', 'load_skill', { name: 'csv' })] },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('s3', 'start_job', { kind: 'summary-report', input: '/sandbox/data' })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('s4', 'list_dir', { path: '/sandbox/data' })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('s5', 'csv_inspect', { path: '/sandbox/data/sales.csv' })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('s6', 'csv_inspect', { path: '/sandbox/data/regions.csv', column: 'region' })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('s7', 'collect_job', { id: 'job-1' })] },
      finishReason: 'tool_calls',
    },
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('s8', 'collect_job', { id: 'job-1' })] },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content:
          '统计完成（数字均经 csv_inspect 核对）：/sandbox/data 共 2 个文件、8 个数据行（sales 5 行、regions 3 行，不含表头）；区域分布 north×2、south×2、east×1；amount 合计 610。后台 job-1 的汇总报告已取回，与我的核对一致。',
      },
      finishReason: 'stop',
    },
  ]
}

/** 打印工具往返：name + 参数要点 + 回喂前两行。 */
function printTraffic(events: readonly LoggedEvent[]): void {
  const outputs = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/result') outputs.set(event.callId, event.output)
  }
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const args = JSON.parse(event.arguments) as Record<string, unknown>
    const target = Object.entries(args)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ')
    console.log(`  [${event.name}] ${target}`)
    for (const line of (outputs.get(event.callId) ?? '').split('\n').slice(0, 2)) console.log(`    回喂 → ${line}`)
  }
}

// —— 共享的虚拟世界 ——
const world = createSandboxWorld()
await seedFiles(world)
/** 技能工具的审批轨迹（askUser 记录，收束段打印）。 */
const approvals: string[] = []
const ctx = assemble(script(), world, approvals)
const log: SessionLog = ctx.get('sessions').log
const rosterBefore = ctx.get('tools').registry.schemas().map((schema) => schema.name)

// —— 第一幕：技能是「规程 + 工具」的组合，加载让两样同时生效 ——
console.log('—— 第一幕：load_skill 一次带来规程（上下文）与工具（名册）——')
await ctx.get('agent').run('统计 /sandbox/data 下的销售数据；顺手挂一个后台汇总报告的 job。')
printTraffic(log.events)
const rosterAfter = ctx.get('tools').registry.schemas().map((schema) => schema.name)
const added = rosterAfter.filter((name) => !rosterBefore.includes(name))
console.log(`名册差异：加载前 ${rosterBefore.length} 个工具；加载后 ${rosterAfter.length} 个——新增：${added.join('、')}`)
const systemEvents = log.events.filter((event) => event.type === 'system/message')
if (systemEvents.length !== 1) {
  throw new Error(`应有恰好一条 system/message（技能规程），实际 ${systemEvents.length} 条`)
}
const derived = log.deriveMessages()
const systemMessages = derived.filter((message) => message.role === 'system')
if (systemMessages.length !== 1 || !systemMessages[0]!.content.includes('skill: csv')) {
  throw new Error('派生历史应含且仅含一条 system 规程（skill: csv）——「模型看得见 ⟺ 已落账」被破坏')
}
console.log(
  `落账与投影：system/message 事件 ${systemEvents.length} 条 → 派生历史 system 消息 ${systemMessages.length} 条（首行：${systemMessages[0]!.content.split('\n')[0]}）`,
)
console.log(
  `权限面：技能运行时带来的 csv_inspect 不在装配期权限表里 → 首次调用落入默认 ask，经审批放行后由会话记忆接管（审批 ${approvals.length} 次：${approvals.map((line) => line.split('：')[0]).join('、') || '无'}）——技能扩能力面，人批权限面。`,
)

// —— 第二幕：start/collect 分离——第一次不阻塞，第二次拿结果 ——
console.log('\n—— 收束：start/collect 分离——第一次 collect 不阻塞，第二次拿结果 ——')
const collectResults = log.events
  .filter((event) => event.type === 'tool/result')
  .map((event) => event.output)
  .filter((output) => output.startsWith('job job-1'))
const [firstCollect, secondCollect] = collectResults
if (firstCollect === undefined || !firstCollect.includes('running')) {
  throw new Error('第一次 collect 应回喂 running 快照（不阻塞）')
}
if (secondCollect === undefined || !secondCollect.includes('done') || !secondCollect.includes('8 个数据行')) {
  throw new Error('第二次 collect 应回喂 done 快照与报告结果')
}
console.log(`  第一次 collect（不阻塞）：${firstCollect.split('\n')[0]}`)
console.log(`  第二次 collect（终态）：${secondCollect.split('\n')[0]}`)
console.log(`  ${secondCollect.split('\n').slice(1).join(' ')}`)
const job = ctx.get('workflows').snapshotOf('job-1')
console.log(
  `job 终态：${job.id}（${job.kind}）status=${job.status}，走过 ${job.progress.length} 个进度步骤；主对话期间它从未阻塞任何一步。`,
)
console.log(`父的最终回答：${derived.at(-1)?.content ?? ''}`)
