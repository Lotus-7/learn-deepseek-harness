import { createMockModel, toolCall, type Model, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx } from './cordis'
import { deterministicSummarize } from './compaction'
import type { LoggedEvent } from './log'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { permissionPlugin } from './plugin-permission'
import { compactionPlugin } from './plugin-compaction'
import { loopPlugin } from './plugin-loop'
import { durablePlugin } from './plugin-durable'
import {
  SESSION_FORMAT_VERSION,
  forkSessionFile,
  makeScratchDir,
  resumeSession,
  scanFile,
  SessionFile,
} from './persistence'
import { fsTools } from './fs-tools'
import {
  addTool,
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
import { renderTranscript } from './transcript'

// —— s12 的技能与工作流、s10 的世界、s11 的委派原样在场（复制前进）；
// 本课叠加持久层：durable 插件（落账即落盘）+ JSONL 会话文件
// （resumeSession / forkSessionFile / scanFile / renderTranscript）。
// 演示四幕：跑对话落盘 → 「进程重启」后 resume 续聊（模型看得到重启前的
// 全部历史）→ fork 出支线另走一条路 → replay 打印完整 transcript。

/** s12 复制前进的工具名册：旧工具照旧注册，fs / run_command / delegate 与技能、工作流工具在装配处追加。 */
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

/** 本课权限规则（s12 原样：放行全部装配期工具）。 */
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
 * csv 技能（s12 的规程精简版，能力位保留）：本课剧本不再加载它，但技能
 * 插件在场——resume 一节的要点恰好在这里：日志恢复的是「模型看得见的
 * 事实」，**不恢复**运行时装配（名册里的技能工具、权限的会话记忆都是
 * 进程态，重启后回零）。dsh 把 agentPreset 持久化进 SessionHeader，就是
 * 为了让 resume 不至于恢复出一段「历史里调过这些工具、现在却没装配它们」
 * 的会话；教学版装配固定，不面对这个问题，README 讲清差距。
 */
function csvSkill(ctx: Ctx): Skill {
  return {
    name: 'csv',
    description: '结构化表格（CSV）数据的检查与统计规程',
    instructions: '[skill: csv] 处理 CSV 前先核对列结构与行数，结论只引用核对过的数字。',
    tools: [],
  }
}

/** s12 的 summary-report 工作流位保留（本课剧本不启动它）。 */
function summaryReportWorkflow(ctx: Ctx): JobDefinition {
  return {
    kind: 'summary-report',
    description: '后台汇总一个数据目录（本课不启动，注册表在场证明复制前进完整）',
    run: async function* (input: string) {
      yield `（未启动）读取数据目录清单：${input}`
      return '（未启动）'
    },
  }
}

/** 装配选项：durable 文件与 resume 种子（都省略 = s12 行为的纯内存会话）。 */
interface AssembleOptions {
  /** 会话文件：提供时挂 durable 插件（落账即落盘）。 */
  file?: SessionFile
  /** 种子事件：提供时日志以重放构造（resume 的新实例）。 */
  seed?: readonly LoggedEvent[]
  /** askUser 的记录通道。 */
  approvals: string[]
}

/**
 * 装配：五件套 + 世界 + 子代理 + 技能 + 工作流（s12 全在场）+ 本课的
 * durable 插件。与 s12 的差别只有两处：model 接受现成实例（演示要拿住
 * mock 的 calls 做请求断言）；可选 seed / file 分别服务 resume 与落盘。
 * @param model - 模型适配器（mock；保留引用以检查模型到底看到了什么）。
 * @param world - 共享的执行世界。
 * @param options - durable 文件、种子事件、审批记录通道。
 * @returns 装配好的 ctx。
 */
function assemble(model: Model, world: ExecutionWorld, options: AssembleOptions): Ctx {
  const ctx = new Ctx()
  const delegate = delegateTool(ctx, { defaultTools: ['read_file', 'list_dir'] })
  ctx.mount(modelPlugin(model))
  ctx.mount(
    toolsSessionPlugin(
      [...BASE_TOOLS, ...fsTools(ctx), ...worldTools(ctx), delegate, ...skillTools(ctx), ...workflowTools(ctx)],
      { seed: options.seed },
    ),
  )
  ctx.mount(
    permissionPlugin({
      rules: { ...PERMISSION_RULES },
      askUser: async (question) => {
        options.approvals.push(`${question.tool}：${question.reason}`)
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
  if (options.file !== undefined) ctx.mount(durablePlugin(options.file))
  ctx.mount(loopPlugin())
  return ctx
}

/** 断言：两个事件序列逐事件（含 seq 与全部字段）完全一致。 */
function assertSameEvents(actual: readonly LoggedEvent[], expected: readonly LoggedEvent[], what: string): void {
  const same =
    actual.length === expected.length &&
    actual.every((event, index) => JSON.stringify(event) === JSON.stringify(expected[index]))
  if (!same) {
    throw new Error(`${what}：磁盘 ${actual.length} 条 / 内存 ${expected.length} 条，存在差异——落账即落盘被破坏`)
  }
}

/** 取日志里最后一条 assistant 文本的辅助（收束打印用）。 */
function lastAssistantText(events: readonly LoggedEvent[]): string {
  for (const event of events.slice().reverse()) {
    if (event.type === 'assistant/message' && event.message.content !== null) return event.message.content
  }
  return ''
}

// —— 共享的虚拟世界（三幕共用，模拟「同一台机器」；真实重启里内存世界会消失，会话文件不会）——
const world = createSandboxWorld()
/** 审批轨迹（s12 语义照旧）。 */
const approvals: string[] = []
/** 演示临时目录（系统临时目录下唯一前缀；收束段打印路径，文件留着可打开看）。 */
const scratch = makeScratchDir('s13-demo-')
const mainPath = `${scratch}/main.jsonl`
const branchPath = `${scratch}/branch.jsonl`

// —— 第一幕：跑一段对话，落账即落盘 ——
console.log(`—— 第一幕：对话落盘（${mainPath}）——`)
const mainFile = SessionFile.materialize(
  mainPath,
  { version: SESSION_FORMAT_VERSION, id: 'main', createdAt: Date.now() },
  [],
)
const act1Model = createMockModel([
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('e1', 'echo', { text: '暗号：榴莲酥' })] },
    finishReason: 'tool_calls',
  },
  { message: { role: 'assistant', content: 'echo 已确认，暗号记住：榴莲酥。' }, finishReason: 'stop' },
])
const ctx1 = assemble(act1Model, world, { file: mainFile, approvals })
await ctx1.get('agent').run('记住暗号：榴莲酥。先用 echo 把它复述一遍。')
const log1: readonly LoggedEvent[] = ctx1.get('sessions').log.events
assertSameEvents(scanFile(mainPath).events, log1, '第一幕落盘检查')
console.log(
  `  落盘 ${log1.length} 条事件（turn 1：一问、一次 echo、一答），逐事件与内存日志一致——append 返回时已 fsync。`,
)
/** 第一幕 turn/end 的 seq：本演示的 fork 边界。 */
const act1End = log1.length - 1
if (log1.at(-1)?.type !== 'turn/end') throw new Error('第一幕最后一个事件应是 turn/end（fork 要的安全边界）')

// —— 第二幕：进程「重启」——新实例 resume 同一文件，模型记得之前说过什么 ——
console.log('\n—— 第二幕：进程重启——新实例 resume 同一文件，模型记得暗号 ——')
// 模拟重启：从此不再触碰 ctx1 / act1Model / 内存日志，一切从文件开始。
const resumed = resumeSession(mainPath)
if (resumed.warnings.length > 0) throw new Error(`干净文件不应有恢复警告，实际：${resumed.warnings.join('；')}`)
// 主线从 turn 2 一路用到 fork 后的 turn 3：剧本两条。
const mainModel = createMockModel([
  { message: { role: 'assistant', content: '暗号是榴莲酥——这是重启前的对话里定的，日志我看得见。' }, finishReason: 'stop' },
  { message: { role: 'assistant', content: '主线回答：暗号「榴莲酥」三个字。' }, finishReason: 'stop' },
])
const ctx2 = assemble(mainModel, world, { seed: resumed.events, file: SessionFile.openAppend(mainPath), approvals })
const turnBefore = ctx2.get('sessions').log.nextTurn()
if (turnBefore !== 2) throw new Error(`resume 后 turn 应从 2 续接，实际 ${turnBefore}`)
const seqBefore = ctx2.get('sessions').log.events.length
await ctx2.get('agent').run('我们之前定的暗号是什么？')
// 硬断言：模型看到的历史里有重启前的用户输入——「记得」不靠剧本自觉，靠请求检查。
const firstRequest = mainModel.calls[0]
if (!firstRequest?.some((message) => message.role === 'user' && message.content?.includes('记住暗号：榴莲酥'))) {
  throw new Error('resume 后的第一次请求应包含重启前的用户输入——「模型能看到全部历史」被破坏')
}
const logAfterTurn2: readonly LoggedEvent[] = ctx2.get('sessions').log.events
if (logAfterTurn2[seqBefore]?.seq !== seqBefore) {
  throw new Error(`续写事件的 seq 应从 ${seqBefore} 续接不重置，实际 ${String(logAfterTurn2[seqBefore]?.seq)}`)
}
console.log(`  resume：重放 ${resumed.events.length} 条事件重建日志；turn 从 ${turnBefore} 续接，新事件 seq 从 ${seqBefore} 续接不重置。`)
console.log(`  请求检查：重启后第一次模型请求包含重启前的用户输入（「记住暗号：榴莲酥」）。`)
console.log(`  模型回答：${lastAssistantText(logAfterTurn2)}`)

// —— 第三幕：fork——从第一幕边界分出支线，主线支线各走各路 ——
console.log(`\n—— 第三幕：fork——支线从第一幕末尾（seq ${act1End}）分出，两边独立增长 ——`)
const mainLenAtFork = scanFile(mainPath).events.length
const forked = forkSessionFile(mainPath, act1End, branchPath, 'branch')
console.log(
  `  支线 ${branchPath}：继承 ${forked.events.length} 条前缀（header：parentSession=${forked.header.parentSession}，seedLength=${forked.header.seedLength}）。`,
)
// 主线（resume 出的活实例）继续第三问——turn 3。
await ctx2.get('agent').run('只看暗号本身：它有几个字？')
// 支线另走一条路：同样只看得见第一幕的历史。
const branchModel = createMockModel([
  { message: { role: 'assistant', content: '支线回答：Durian pastry——支线的我会拿它当口头禅。' }, finishReason: 'stop' },
])
const ctxBranch = assemble(branchModel, world, { seed: forked.events, file: forked.file, approvals })
await ctxBranch.get('agent').run('把暗号翻译成英文，并说说你会怎么用它。')

const mainEvents = scanFile(mainPath).events
const branchEvents = scanFile(branchPath).events
const seedLength = forked.header.seedLength ?? 0
assertSameEvents(branchEvents.slice(0, seedLength), mainEvents.slice(0, seedLength), '支线前缀 = 主线前缀')
const mainOwn = mainEvents.slice(mainLenAtFork)
const branchOwn = branchEvents.slice(seedLength)
if (mainOwn.length === 0 || branchOwn.length === 0) throw new Error('fork 后两边都应有自己的新事件')
const mainOwnText = JSON.stringify(mainOwn)
const branchOwnText = JSON.stringify(branchOwn)
if (mainOwnText.includes('翻译成英文') || branchOwnText.includes('几个字')) {
  throw new Error('fork 后两条线互不可见——串线了')
}
console.log(
  `  fork 后：主线新增 ${mainOwn.length} 条（turn 3，问「几个字」），支线新增 ${branchOwn.length} 条（turn 2，问「翻译成英文」）——互不可见。`,
)

// —— 第四幕：replay——仅凭文件打印人类可读 transcript ——
console.log('\n—— 第四幕：replay——仅凭文件打印完整 transcript ——')
console.log('· 主线（main.jsonl）：')
for (const line of renderTranscript(mainEvents)) console.log(`  ${line}`)
console.log('· 支线（branch.jsonl）：')
for (const line of renderTranscript(branchEvents)) console.log(`  ${line}`)
const mainLines = renderTranscript(mainEvents)
const branchLines = renderTranscript(branchEvents)
if (mainLines.slice(0, seedLength).join('\n') !== branchLines.slice(0, seedLength).join('\n')) {
  throw new Error('两份日志的共享前缀应渲染出逐行相同的 transcript')
}
console.log(
  `\n收束：两份 transcript 的前 ${seedLength} 行（共享前缀）逐行相同；会话目录在 ${scratch}——JSONL 是真实文件，每行一个事件，seq 即行号减一头行。`,
)
