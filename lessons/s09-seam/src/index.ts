import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx } from './cordis'
import { deterministicSummarize } from './compaction'
import type { LoggedEvent, SessionLog } from './log'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { permissionPlugin } from './plugin-permission'
import { compactionPlugin } from './plugin-compaction'
import { loopPlugin } from './plugin-loop'
import {
  addTool,
  cachedStatsTool,
  deleteFileTool,
  echoTool,
  fetchStatsTool,
  moveToTrashTool,
  searchLogsTool,
  slowScanTool,
  type Tool,
} from './tools'
import { createMemoryFs } from './fs-memory'
import { createRemoteFs } from './fs-remote'
import { fsPlugin } from './plugin-fs'
import { fsTools } from './fs-tools'
import type { FsService } from './fs-service'

// —— s08 的五件套世界原样在场（九个旧工具照旧注册）；本课叠加 fs 能力缝：
// Service Definition（fs-service.ts）、两个 Provider（fs-memory / fs-remote）、
// 三个 Consumer（fs-tools）。provider 在装配行上显式选择，其余一切零改动。——

/**
 * s08 复制前进的工具名册，只有一处取舍：s04 的演示用 read_file（返回
 * 硬编码文本的假工具）不再挂载——名字是模型面契约，一个世界一份名册；
 * seam 上的真 read_file 顶上它的位置（两把工具重名时注册表当场抛错，
 * 「重名通常是重复装配」的响亮失败替我们发现了这次换代）。
 */
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

/** 本课权限规则：三个 fs 工具放行，其余维持默认（ask 无通道 → fail-safe 拒绝）。 */
const PERMISSION_RULES = { read_file: 'allow', write_file: 'allow', list_dir: 'allow' } as const

/**
 * 装配一个世界：五件套 + 选定的 fs provider + 三个 Consumer 工具。
 * 「选谁」就是 `fsPlugin(...)` 这一行——配置在装配处显式决定 provider；
 * Consumer 工具只认 `fs` 服务键，这一行换成 `fsPlugin(createRemoteFs())`
 * 或任何第三个 provider，世界整体跟着走，别处一个字不改。
 * @param fs - 装配选定的 provider 实例。
 * @param script - 剧本模型的响应序列。
 * @returns ctx 与 provider 的卸载函数（收束幕演示能力随 provider 消失）。
 */
function assembleWorld(
  fs: FsService,
  script: readonly ModelResponse[],
): { ctx: Ctx; unmountFs: () => void } {
  const ctx = new Ctx()
  ctx.mount(modelPlugin(createMockModel([...script])))
  ctx.mount(toolsSessionPlugin([...BASE_TOOLS, ...fsTools(ctx)]))
  ctx.mount(permissionPlugin({ rules: { ...PERMISSION_RULES } }))
  ctx.mount(compactionPlugin({ threshold: 700, keepTail: 4, summarize: deterministicSummarize }))
  const unmountFs = ctx.mount(fsPlugin(fs))
  ctx.mount(loopPlugin())
  return { ctx, unmountFs }
}

/** 第一幕的任务：建文件 → 列目录 → 读回 → 引用早期写入内容的回答。 */
const MISSION_PROMPT = '把「集群共 47 台节点；svc-01 过载引发级联重启」记成笔记：写入文件、列出目录、读回内容确认。'

/**
 * 第一幕剧本（按世界基目录生成）：同一个任务，路径前缀不同——
 * 两个世界跑的是同一份行为，只是「家」在不同 provider 的可达范围内。
 * @param base - 本世界的基目录（世界 A 用 /workspace，世界 B 用 /remote/workspace）。
 */
function missionScript(base: string): ModelResponse[] {
  const notes = `${base}/notes.md`
  return [
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'write_file', { path: notes, content: '集群巡检结论：共 47 台节点；svc-01 过载引发级联重启。' })] },
      finishReason: 'tool_calls',
    },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'list_dir', { path: base })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('t3', 'read_file', { path: notes })] }, finishReason: 'tool_calls' },
    {
      message: { role: 'assistant', content: '已确认：笔记读回与写入一致——集群共 47 台节点，svc-01 过载引发级联重启。' },
      finishReason: 'stop',
    },
  ]
}

/** 第二幕剧本：模型先按用户原话写越界路径，被拒后按补救语换到根内。 */
function boundaryScript(): ModelResponse[] {
  return [
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('b1', 'write_file', { path: '/workspace/attempt.md', content: '第一次尝试' })] },
      finishReason: 'tool_calls',
    },
    {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('b2', 'write_file', { path: '/remote/workspace/attempt.md', content: '改用根内路径' })] },
      finishReason: 'tool_calls',
    },
    {
      message: { role: 'assistant', content: '已写入 /remote/workspace/attempt.md——第一次尝试的路径在 /remote 之外被拒，我按错误里的补救语换到了根内。' },
      finishReason: 'stop',
    },
  ]
}

/** 收束幕剧本：读一个文件（provider 已被卸载，能力应当响亮地不可用）。 */
function finaleScript(): ModelResponse[] {
  return [
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'read_file', { path: '/remote/notes.md' })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: '文件系统能力此刻不在场（服务未装配），我读不了文件；请先恢复文件系统 provider。' }, finishReason: 'stop' },
  ]
}

/** 打印一次任务的全部工具往返：每次调用的目标路径与回喂结果的首行。 */
function printToolTraffic(events: readonly LoggedEvent[]): void {
  const outputs = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/result') outputs.set(event.callId, event.output)
  }
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const args = JSON.parse(event.arguments) as Record<string, unknown>
    const target = args.path !== undefined ? String(args.path) : JSON.stringify(args)
    const output = outputs.get(event.callId) ?? ''
    console.log(`  [${event.name}] ${target}`)
    console.log(`    回喂 → ${output.split('\n')[0]}`)
  }
}

/** 事件类型序列（两世界对比的就是这条序列的同形性）。 */
function sequenceOf(log: SessionLog): string[] {
  return log.events.map((event) => event.type)
}

/** 跑一次任务并计时（耗时特征是两个 provider 的部署差异之一）。 */
async function runMission(fs: FsService, base: string): Promise<{ log: SessionLog; elapsedMs: number }> {
  const { ctx } = assembleWorld(fs, missionScript(base))
  const started = Date.now()
  await ctx.get('agent').run(MISSION_PROMPT)
  return { log: ctx.get('sessions').log, elapsedMs: Date.now() - started }
}

// —— 第一幕：同一任务在两个世界各跑一遍 ——
console.log('—— 第一幕：同一任务在两个世界各跑一遍 ——')
const memoryWorld = await runMission(createMemoryFs(), '/workspace')
const remoteWorld = await runMission(createRemoteFs(), '/remote/workspace')
console.log('世界 A：MemoryFs（进程内 Map、全路径可达、零延迟）')
printToolTraffic(memoryWorld.log.events)
console.log('世界 B：RemoteFs（/remote 前缀隔离、每次操作 +40ms 模拟往返）——剧本与工具一个字没换')
printToolTraffic(remoteWorld.log.events)
if (sequenceOf(memoryWorld.log).join() !== sequenceOf(remoteWorld.log).join()) {
  throw new Error('两个世界的事件类型序列不同形：换 provider 不该改变对话的形状（契约在同形性上兑现）')
}
console.log(`事件类型序列逐条同形（各 ${memoryWorld.log.events.length} 条，测试钉住）：`)
console.log(`  ${sequenceOf(memoryWorld.log).join(' → ')}`)
console.log(
  `耗时特征：世界 A ${memoryWorld.elapsedMs}ms / 世界 B ${remoteWorld.elapsedMs}ms——` +
    '远端世界每次工具往返多付一次延迟，对话形状却一个事件不差。',
)
const answer = memoryWorld.log.deriveMessages().at(-1)?.content ?? ''
if ((remoteWorld.log.deriveMessages().at(-1)?.content ?? '') !== answer) {
  throw new Error('两个世界的最终回答不一致：同一契约上的两个 provider 应产出同一对话')
}
console.log(`最终回答（两世界逐字相同）：${answer}`)

// —— 第二幕：远端世界的边界——错误作为对话回喂 ——
console.log('\n—— 第二幕：远端世界的边界——错误作为对话回喂 ——')
const boundary = assembleWorld(createRemoteFs(), boundaryScript())
await boundary.ctx.get('agent').run('把一份简短说明写到 /workspace/attempt.md。')
printToolTraffic(boundary.ctx.get('sessions').log.events)
console.log('错误不是崩溃：provider 抛类型化 FsError，Consumer 补一句「改用根内路径」的补救语，')
console.log('管线把它落成回喂模型的 tool/result（s02/s04 的回喂规矩在 seam 上的延续）——模型自己换了安全路径。')

// —— 收束：选 provider 是显式的一步 ——
console.log('\n—— 收束：选 provider 是显式的一步（装配行上选，Consumer 里没有默认）——')
const dup = assembleWorld(createMemoryFs(), [])
try {
  dup.ctx.mount(fsPlugin(createMemoryFs()))
  throw new Error('不该到这里：重复贡献服务应当抛错')
} catch (error) {
  console.log(`① 直接再挂一个 provider（忘了先卸载）→ ${(error as Error).message.split('；')[0]}`)
}
const bare = assembleWorld(createRemoteFs(), finaleScript())
bare.unmountFs()
console.log(`② 卸载 provider 后已挂载 ${bare.ctx.plugins.join('、')}`)
await bare.ctx.get('agent').run('读一下 /remote/notes.md')
for (const event of bare.ctx.get('sessions').log.events) {
  if (event.type === 'tool/result') console.log(`   read_file 回喂 → ${event.output}`)
}
const lastEvent = bare.ctx.get('sessions').log.events.at(-1)
console.log(`   turn 照常收尾（${lastEvent?.type === 'turn/end' ? `turn/end(${lastEvent.reason})` : '未收尾！'}）——能力消失被模型看见，进程不崩。`)
