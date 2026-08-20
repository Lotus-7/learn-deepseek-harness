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

// —— s10 的世界原样在场（统一执行世界、五件套、全部旧工具）；本课叠加子代理
// 委派：Service Definition（subagent-service.ts）、in-process Provider
// （subagent-provider.ts）、服务注册（subagent-plugin.ts）与 Consumer
// （subagent-tools.ts 的 delegate 工具）。

/** s10 复制前进的工具名册：旧工具照旧注册，fs / run_command / delegate 在装配处追加。 */
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

/** 本课权限规则：在 s10 基础上放行 delegate（委派本身是一个工具调用）。 */
const PERMISSION_RULES = {
  read_file: 'allow',
  write_file: 'allow',
  list_dir: 'allow',
  run_command: 'allow',
  delegate: 'allow',
} as const

/**
 * 装配父代理：五件套 + 世界 + 子代理能力 + delegate 工具。
 * 子代理的默认白名单经参数注入（收束①要故意塞错它）：默认 read_file /
 * list_dir——**不含 delegate**，防无限递归的第一道闸是装配约定。
 * @param script - 剧本模型的响应序列（父与全部子代理共用一个模型实例，剧本按全局调用序编排）。
 * @param world - 共享的执行世界：父与子经同一批工具闭包落到同一个世界（父写的文件子读得到）。
 * @param delegateDefaults - delegate 的默认工具白名单。
 * @returns 装配好的 ctx。
 */
function assemble(
  script: readonly ModelResponse[],
  world: ExecutionWorld,
  delegateDefaults: readonly string[] = ['read_file', 'list_dir'],
): Ctx {
  const ctx = new Ctx()
  const delegate = delegateTool(ctx, { defaultTools: delegateDefaults })
  ctx.mount(modelPlugin(createMockModel([...script])))
  ctx.mount(toolsSessionPlugin([...BASE_TOOLS, ...fsTools(ctx), ...worldTools(ctx), delegate]))
  ctx.mount(permissionPlugin({ rules: { ...PERMISSION_RULES } }))
  ctx.mount(compactionPlugin({ threshold: 700, keepTail: 4, summarize: deterministicSummarize }))
  ctx.mount(worldPlugin(world))
  ctx.mount(subagentPlugin(createInProcessSubagentProvider(ctx)))
  ctx.mount(loopPlugin())
  return ctx
}

/** 演示文件：两个报告类文件 + 一个笔记（第一幕统计 reports，第二幕统计 notes）。 */
async function seedFiles(world: ExecutionWorld): Promise<void> {
  await world.writeFile('/sandbox/reports/alpha.md', '集群共 47 台节点\nsvc-01 过载\n引发级联重启\n')
  await world.writeFile(
    '/sandbox/reports/beta.md',
    '已扩容至 64 台\n队列积压清零\n延迟回落正常\n计划周三复盘\n值班表已更新\n',
  )
  await world.writeFile('/sandbox/notes.md', '巡检结论：整体恢复\n待办：复盘会议材料\n')
}

/** 第一幕剧本：父委派统计 → 子列目录、逐个读取、汇总回答 → 父收结论。 */
function censusScript(): ModelResponse[] {
  return [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('p1', 'delegate', {
            task: '列出 /sandbox/reports 目录下的全部文件，逐个读取内容，统计所有文件的总行数并给出每个文件的行数',
          }),
        ],
      },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('c1', 'list_dir', { path: '/sandbox/reports' })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('c2', 'read_file', { path: '/sandbox/reports/alpha.md' })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('c3', 'read_file', { path: '/sandbox/reports/beta.md' })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: { role: 'assistant', content: 'reports 目录共 2 个文件：alpha.md 3 行、beta.md 5 行，合计 8 行。' },
      finishReason: 'stop',
    },
    {
      message: {
        role: 'assistant',
        content:
          '委派完成——子代理统计出 reports 共 2 个文件、合计 8 行（alpha 3 行 + beta 5 行）。目录列举与逐文件读取都发生在子的私有上下文里，没有进入我的对话：我只拿到结论与开销。',
      },
      finishReason: 'stop',
    },
  ]
}

/**
 * 第二幕剧本：父显式给子 delegate（递归解禁）→ 子再委派孙 → 孙试图开第三层被
 * 深度上限拦下（回喂）→ 孙改用自己的工具完成 → 逐层收结论。
 */
function recursionScript(): ModelResponse[] {
  return [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('r1', 'delegate', {
            task: '统计 /sandbox/notes.md 的总行数',
            tools: ['delegate', 'read_file', 'list_dir'],
          }),
        ],
      },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('r2', 'delegate', {
            task: '读取 /sandbox/notes.md 并数出总行数',
            tools: ['delegate', 'read_file'],
          }),
        ],
      },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('r3', 'delegate', { task: '把统计再向下转包一层', tools: ['read_file'] })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('r4', 'read_file', { path: '/sandbox/notes.md' })],
      },
      finishReason: 'tool_calls',
    },
    {
      message: {
        role: 'assistant',
        content: 'notes.md 共 2 行。我曾试图再向下委派一层，被深度上限拦下并回喂，随后改用自己手上的 read_file 完成。',
      },
      finishReason: 'stop',
    },
    {
      message: {
        role: 'assistant',
        content: 'notes.md 共 2 行（下层试图开启第三层委派，被深度上限拦下后自行读取完成）。',
      },
      finishReason: 'stop',
    },
    {
      message: {
        role: 'assistant',
        content:
          '二级委派完成——notes.md 共 2 行。第二层试图开启第三层委派时，深度 3 超过上限 2，spawn 在启动之前被拒、错误作为 tool/result 回喂；它改用自己手上的工具完成了任务。',
      },
      finishReason: 'stop',
    },
  ]
}

/** 事件类型序列（隔离对照打的就是这条序列）。 */
function sequenceOf(log: SessionLog): string[] {
  return log.events.map((event) => event.type)
}

/** 打印父日志的工具往返：delegate 显示任务摘要与工具集，其余工具显示路径。 */
function printParentTraffic(events: readonly LoggedEvent[]): void {
  const outputs = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/result') outputs.set(event.callId, event.output)
  }
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const args = JSON.parse(event.arguments) as Record<string, unknown>
    const target =
      args.task !== undefined
        ? `${String(args.task).slice(0, 28)}…${Array.isArray(args.tools) ? `（显式工具集：${args.tools.map(String).join('、')}）` : '（默认白名单）'}`
        : args.path !== undefined
          ? String(args.path)
          : JSON.stringify(args)
    const lines = (outputs.get(event.callId) ?? '').split('\n')
    console.log(`  [${event.name}] ${target}`)
    for (const line of lines.slice(0, 2)) console.log(`    回喂 → ${line}`)
    if (event.name === 'delegate') console.log(`           …${lines.at(-1)?.slice(0, 56)}`)
  }
}

/** 打印一个子代理的私有日志概览（「单独可查」的演示面）。 */
function printChildLog(id: string, log: SessionLog): void {
  const used = [...new Set(log.events.filter((event) => event.type === 'tool/call').map((event) => event.name))]
  console.log(`子代理 ${id} 的私有日志（单独可查，共 ${log.events.length} 个事件，使用工具 ${used.join('、') || '无'}）：`)
  console.log(`  ${sequenceOf(log).join(' → ')}`)
}

// —— 共享的虚拟世界：父与全部子代理经同一批工具闭包落到它（执行世界是部署级共享） ——
const world = createSandboxWorld()
await seedFiles(world)

// —— 第一幕：把「统计文件」委派出去 ——
console.log('—— 第一幕：把「统计文件」委派出去（子的默认白名单 read_file/list_dir，不含 delegate） ——')
const census = assemble(censusScript(), world)
const censusLog = census.get('sessions').log
await census.get('agent').run('帮我统计 /sandbox/reports 下的内容规模。')
printParentTraffic(censusLog.events)
console.log(`父的最终回答：${censusLog.deriveMessages().at(-1)?.content ?? ''}`)
printChildLog('sub-1', census.get('subagents').logOf('sub-1'))
// 隔离断言：父日志不含子代理的任何内部工具事件（read_file / list_dir 只存在于子的日志）。
const parentInternal = censusLog.events.filter((event) => event.type === 'tool/call' && event.name !== 'delegate')
if (parentInternal.length > 0) {
  throw new Error(`父日志不该内联子代理的内部工具事件（发现 ${parentInternal.length} 条）——隔离被破坏`)
}
console.log(
  `隔离对照：父日志 ${censusLog.events.length} 个事件、0 条来自子代理内部；子的任务文本与全部工具往返只在子的日志里（${census.get('subagents').logOf('sub-1').events.length} 个事件）。`,
)
console.log(`  父：${sequenceOf(censusLog).join(' → ')}`)

// —— 第二幕：显式递归与深度上限 ——
console.log('\n—— 第二幕：显式递归与深度上限（maxDepth 默认 2：孙可以出生，曾孙被拒） ——')
const recursion = assemble(recursionScript(), world)
const recursionLog = recursion.get('sessions').log
await recursion.get('agent').run('统计 /sandbox/notes.md，需要的话可以向下委派。')
printParentTraffic(recursionLog.events)
console.log(`父的最终回答：${recursionLog.deriveMessages().at(-1)?.content ?? ''}`)
printChildLog('sub-1', recursion.get('subagents').logOf('sub-1'))
printChildLog('sub-2', recursion.get('subagents').logOf('sub-2'))
// 深度拒绝落在孙（sub-2）自己的对话里：它看得见拒绝文本，父只看见结论。
const refusal = recursion
  .get('subagents')
  .logOf('sub-2')
  .events.filter((event) => event.type === 'tool/result')
  .map((event) => event.output)
  .find((output) => output.includes('SUBAGENT_DEPTH_EXCEEDED'))
if (refusal === undefined) {
  throw new Error('孙代理的 tool/result 里应当有深度拒绝的回喂文本——上限拦截没有生效')
}
console.log(`深度拦截回喂（在孙 sub-2 自己的对话里）：${refusal.split('\n')[0]}`)
console.log('第二幕共启动 2 个子代理（sub-1=子、sub-2=孙；两幕是独立会话，编号各自从 sub-1 起）——深度 3 的第 3 个从未出生：spawn 在启动之前被拒。')

// —— 收束：两道闸与上下文经济学 ——
console.log('\n—— 收束：防递归的两道闸，与委派的上下文经济学 ——')
try {
  delegateTool(new Ctx(), { defaultTools: ['read_file', 'delegate'] })
  throw new Error('不该到这里：默认白名单含 delegate 应当构造期抛错')
} catch (error) {
  console.log(`① 装配期闸：defaultTools 塞进 'delegate' → ${(error as Error).message.split('——')[0].trim()}`)
}
console.log('② 运行期闸：显式点名 delegate 合法，由绝对深度上限兜底——拒绝发生在 spawn 之前，零副作用、错误回喂。')
const childTotal =
  census.get('subagents').logOf('sub-1').events.length +
  recursion.get('subagents').logOf('sub-1').events.length +
  recursion.get('subagents').logOf('sub-2').events.length
console.log(
  `上下文经济学：两幕的父日志各 ${censusLog.events.length}/${recursionLog.events.length} 个事件，三个子日志合计 ${childTotal} 个事件——父的增长是 O(委派次数)，子的账本各自独立、经 subagents.logOf 单独可查。`,
)
