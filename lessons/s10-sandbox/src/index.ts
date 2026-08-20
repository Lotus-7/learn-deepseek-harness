import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { createLocalWorld } from './world-local'
import { createSandboxWorld } from './world-sandbox'
import type { ExecutionWorld } from './world-service'

// —— s09 的世界原样在场（fs 契约、五件套、八个旧工具）；本课叠加统一执行
// 世界：Service Definition（world-service.ts）、两个 Provider（world-local /
// world-sandbox）、Consumer（world-tools 的 run_command；s09 的三个 fs 工具
// 经 'fs' 键零改动续用——同一个世界对象贡献两个键，见 world-plugin.ts）。

/** s09 复制前进的工具名册：旧工具照旧注册，fs 工具与 run_command 在装配处追加。 */
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

/** 本课权限规则：fs 三工具 + run_command 放行，其余维持默认（ask 无通道 → fail-safe 拒绝）。 */
const PERMISSION_RULES = { read_file: 'allow', write_file: 'allow', list_dir: 'allow', run_command: 'allow' } as const

/**
 * 装配一个世界：五件套 + 选定的 execution-world provider + 四个 Consumer
 * 工具。「选谁」就是 `worldPlugin(...)` 这一行——换成另一个 provider，fs 与
 * spawn 两面同时搬家，其余装配一个字不改（与 s09 的 fsPlugin 行同构，
 * 只是把「文件系统」升格成「执行世界」）。
 * @param world - 装配选定的世界实例。
 * @param script - 剧本模型的响应序列。
 * @returns ctx 与 world 的卸载函数。
 */
function assembleWorld(
  world: ExecutionWorld,
  script: readonly ModelResponse[],
): { ctx: Ctx; unmountWorld: () => void } {
  const ctx = new Ctx()
  ctx.mount(modelPlugin(createMockModel([...script])))
  ctx.mount(toolsSessionPlugin([...BASE_TOOLS, ...fsTools(ctx), ...worldTools(ctx)]))
  ctx.mount(permissionPlugin({ rules: { ...PERMISSION_RULES } }))
  ctx.mount(compactionPlugin({ threshold: 700, keepTail: 4, summarize: deterministicSummarize }))
  const unmountWorld = ctx.mount(worldPlugin(world))
  ctx.mount(loopPlugin())
  return { ctx, unmountWorld }
}

/**
 * 给世界包一层 spawn 计数（演示执行特征用）：接口是结构化的，包装不碰实现
 * ——这也顺带演示了「世界对象可组合」。
 * @param world - 要包装的世界。
 * @returns 包装后的世界与 spawn 调用计数器。
 */
function withSpawnCount(world: ExecutionWorld): { world: ExecutionWorld; spawnCalls: () => number } {
  let calls = 0
  const wrapped: ExecutionWorld = {
    ...world,
    spawn: (command, args) => {
      calls += 1
      return world.spawn(command, args)
    },
  }
  return { world: wrapped, spawnCalls: () => calls }
}

/** 第一幕的巡检笔记：三行、以换行结尾（两个世界的 wc -l 都会数出 3）。 */
const NOTES = '集群共 47 台节点\nsvc-01 过载\n引发级联重启\n'

/** 第一幕的任务：写笔记 → 统计行数 → 读回核对。 */
const MISSION_PROMPT = '把巡检结论记成笔记，统计行数并读回核对。'

/**
 * 第一幕剧本（按世界基目录生成）：同一段「脚本」在两个世界跑——写文件、
 * wc 统计、cat 读回，工具与剧本一个字不换，只有「家」的坐标不同。
 * @param base - 本世界的基目录（世界 A 是本机临时目录，世界 B 是 /sandbox）。
 */
function missionScript(base: string): ModelResponse[] {
  const notes = `${base}/notes.md`
  return [
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'write_file', { path: notes, content: NOTES })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'run_command', { command: 'wc', args: ['-l', notes] })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('t3', 'run_command', { command: 'cat', args: [notes] })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: '已核对：笔记共 3 行；cat 读回与写入逐字一致——集群共 47 台节点。' }, finishReason: 'stop' },
  ]
}

/**
 * 第二幕剧本（本机世界）：模型习惯性发 bash -c —— 真机器上它当然能跑，
 * 但它不在白名单里；被拒后改用白名单内的 wc 完成同一目标。
 */
function allowlistScript(base: string): ModelResponse[] {
  const manifest = `${base}/manifest.md`
  return [
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('a1', 'write_file', { path: manifest, content: 'node-01\nnode-02\nnode-03\n' })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('a2', 'run_command', { command: 'bash', args: ['-c', `wc -l < ${manifest}`] })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('a3', 'run_command', { command: 'wc', args: ['-l', manifest] })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: 'bash 不在本世界的白名单里被拒；改用白名单内的 wc 完成统计——清单共 3 行。' }, finishReason: 'stop' },
  ]
}

/** 第三幕剧本（虚拟世界）：越界写入与越界读取都被围栏拦下 → 文件放进 /sandbox 后读写都通。 */
function fenceScript(): ModelResponse[] {
  return [
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('f1', 'write_file', { path: '/etc/hosts', content: '127.0.0.1 localhost' })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('f2', 'run_command', { command: 'cat', args: ['/etc/hosts'] })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('f3', 'write_file', { path: '/sandbox/hosts-backup.md', content: '127.0.0.1 localhost' })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('f4', 'run_command', { command: 'cat', args: ['/sandbox/hosts-backup.md'] })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: '越界写入与越界读取都被围栏拦下；把文件放进 /sandbox 之后写与读都通了。' }, finishReason: 'stop' },
  ]
}

/** 打印一次任务的全部工具往返：run_command 显示 argv，fs 工具显示路径。 */
function printToolTraffic(events: readonly LoggedEvent[]): void {
  const outputs = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/result') outputs.set(event.callId, event.output)
  }
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const args = JSON.parse(event.arguments) as Record<string, unknown>
    const target =
      args.command !== undefined
        ? `${String(args.command)}${Array.isArray(args.args) ? ` ${args.args.map(String).join(' ')}` : ''}`
        : args.path !== undefined
          ? String(args.path)
          : JSON.stringify(args)
    const lines = (outputs.get(event.callId) ?? '').split('\n')
    // run_command 的回喂首行是「exit N」——把 stdout 首行也带出来，往返才有信息量。
    const shown = lines[1] === 'stdout:' ? `${lines[0]}；${lines[2] ?? ''}` : (lines[0] ?? '')
    console.log(`  [${event.name}] ${target}`)
    console.log(`    回喂 → ${shown}`)
  }
}

/** 事件类型序列（两世界对比的就是这条序列的同形性）。 */
function sequenceOf(log: SessionLog): string[] {
  return log.events.map((event) => event.type)
}

/**
 * 跑一次任务并计时（耗时特征是两个 provider 的部署差异之一）。
 * @param world - 待考察的世界。
 * @param base - 本世界的基目录（剧本的路径前缀）。
 */
async function runMission(world: ExecutionWorld, base: string): Promise<{ log: SessionLog; elapsedMs: number; spawnCalls: number }> {
  const counted = withSpawnCount(world)
  const { ctx } = assembleWorld(counted.world, missionScript(base))
  const started = Date.now()
  await ctx.get('agent').run(MISSION_PROMPT)
  return { log: ctx.get('sessions').log, elapsedMs: Date.now() - started, spawnCalls: counted.spawnCalls() }
}

// 本地世界的临时根：真磁盘上的工作目录，演示结束清理。
const localRoot = mkdtempSync(join(tmpdir(), 'learn-s10-'))
try {
  // —— 第一幕：同一段脚本在两个世界各跑一遍 ——
  console.log('—— 第一幕：同一段脚本在两个世界各跑一遍 ——')
  const localRun = await runMission(
    createLocalWorld({ root: localRoot, allowedCommands: ['echo', 'cat', 'wc', 'node'] }),
    `${localRoot}/mission`,
  )
  const sandboxRun = await runMission(createSandboxWorld(), '/sandbox')
  console.log('世界 A：LocalWorld（真磁盘 + 真 child_process；命令白名单 echo/cat/wc/node）')
  printToolTraffic(localRun.log.events)
  console.log('世界 B：SandboxWorld（进程内虚拟世界：虚拟 FS + 虚拟命令解释器；围栏 /sandbox）——剧本与工具一个字没换')
  printToolTraffic(sandboxRun.log.events)
  if (sequenceOf(localRun.log).join() !== sequenceOf(sandboxRun.log).join()) {
    throw new Error('两个世界的事件类型序列不同形：换世界不该改变对话的形状（契约在同形性上兑现）')
  }
  console.log(`事件类型序列逐条同形（各 ${localRun.log.events.length} 条，测试钉住）：`)
  console.log(`  ${sequenceOf(localRun.log).join(' → ')}`)
  const answer = localRun.log.deriveMessages().at(-1)?.content ?? ''
  if ((sandboxRun.log.deriveMessages().at(-1)?.content ?? '') !== answer) {
    throw new Error('两个世界的最终回答不一致：同一契约上的两个世界应产出同一对话')
  }
  console.log(`最终回答（两世界逐字相同）：${answer}`)
  console.log(
    `执行特征：spawn 各 ${localRun.spawnCalls}/${sandboxRun.spawnCalls} 次——世界 A 每次 spawn 都 fork 真进程（wc 的输出带真实格式与路径），` +
      `世界 B 全部进程内解释（world-sandbox.ts 不 import child_process，零真进程）；耗时 A ${localRun.elapsedMs}ms / B ${sandboxRun.elapsedMs}ms。`,
  )

  // —— 第二幕：本机世界的白名单——拒绝发生在 fork 之前 ——
  console.log('\n—— 第二幕：本机世界的白名单——拒绝发生在 fork 之前 ——')
  const allowlist = assembleWorld(
    createLocalWorld({ root: localRoot, allowedCommands: ['echo', 'cat', 'wc', 'node'] }),
    allowlistScript(`${localRoot}/allowlist`),
  )
  await allowlist.ctx.get('agent').run('把集群清单写成文件并统计行数。')
  printToolTraffic(allowlist.ctx.get('sessions').log.events)
  console.log('真机器什么都能跑，所以「哪些能跑」必须是显式配置：bash 不在白名单，检查在 fork 之前——')
  console.log('进程根本没启动，拒绝作为带码的 tool/result 回喂，模型改用白名单内的 wc 完成同一目标。')

  // —— 第三幕：虚拟世界的围栏——越界路径写入被拦下 ——
  console.log('\n—— 第三幕：虚拟世界的围栏——越界路径写入被拦下 ——')
  const fence = assembleWorld(createSandboxWorld(), fenceScript())
  await fence.ctx.get('agent').run('把主机清单备份一份并读回。')
  printToolTraffic(fence.ctx.get('sessions').log.events)
  const entries = await fence.ctx.get('fs').listDir('/sandbox')
  console.log(`围栏内的虚拟 FS 清单：${entries.map((entry) => entry.name).join('、')}——越界尝试零副作用，世界里根本不存在 /etc。`)

  // —— 收束：换世界是显式的一行装配；错位装配当场响亮 ——
  console.log('\n—— 收束：换世界是显式的一行装配 ——')
  console.log('装配行 worldPlugin(createLocalWorld(...)) ↔ worldPlugin(createSandboxWorld()) 一行互换，')
  console.log('四个 Consumer（read_file/write_file/list_dir/run_command）零改动——源码里不出现任何实现名，测试钉住。')
  const dup = assembleWorld(createSandboxWorld(), [])
  try {
    dup.ctx.mount(worldPlugin(createLocalWorld({ root: localRoot, allowedCommands: ['echo'] })))
    throw new Error('不该到这里：重复贡献服务应当抛错')
  } catch (error) {
    console.log(`① 同时挂两个世界（fs 与进程想拆到两家）→ ${(error as Error).message.split('；')[0]}`)
  }
  console.log('② 一个对象贡献 fs 与 world 两个键：挂上即成对——「fs 是沙箱、进程是本机」的错位世界在装配期就上不了台。')
} finally {
  rmSync(localRoot, { recursive: true, force: true })
}
