import { createMockModel, toolCall, type ChatMessage, type Model } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { registryOf } from './registry'
import { SessionLog, type LoggedEvent } from './log'
import { createPermissionGuard } from './permission'
import {
  addTool,
  cachedStatsTool,
  deleteFileTool,
  echoTool,
  fetchStatsTool,
  moveToTrashTool,
  readFileTool,
  slowScanTool,
} from './tools'

// s04 的权限层照常在场（复制前进：能力只增不减），本课聚焦它上面的循环收口。
// 演示工具都在允许清单里：取消与错误恢复不是权限问题，别让审批戏份抢戏。
const permission = createPermissionGuard({
  rules: {
    read_file: 'allow',
    move_to_trash: 'allow',
    add: 'allow',
    echo: 'allow',
    delete_file: 'ask',
    slow_scan: 'allow',
    fetch_stats: 'allow',
    cached_stats: 'allow',
  },
})

const registry = registryOf(
  addTool,
  echoTool,
  deleteFileTool,
  readFileTool,
  moveToTrashTool,
  slowScanTool,
  fetchStatsTool,
  cachedStatsTool,
)

/** 打印一段派生历史：模型视角的对话流（取消幕的最后一条不是回答，正是要点）。 */
function printMessages(messages: ChatMessage[]): void {
  for (const m of messages) {
    const detail =
      m.role === 'assistant' && m.tool_calls
        ? `请求工具 ${m.tool_calls.map((c) => c.function.name).join(', ')}`
        : m.role === 'tool'
          ? `工具结果：${m.content}`
          : (m.content ?? '')
    console.log(`[${m.role}] ${detail}`)
  }
}

/** 打印一个日志的 turn 生命周期：start → 若干事实 → end(reason)。 */
function printLifecycle(events: readonly LoggedEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        console.log(`turn ${event.turn} start`)
        break
      case 'turn/end':
        console.log(`turn ${event.turn} end（reason: ${event.reason}）`)
        break
      case 'assistant/message': {
        const calls = event.message.tool_calls?.map((c) => c.function.name).join(', ')
        console.log(`  step：${calls ? `模型请求工具 ${calls}` : (event.message.content ?? '')}`)
        break
      }
      case 'tool/call':
        console.log(`  tool/call ${event.name}(${event.arguments})`)
        break
      case 'tool/result':
        console.log(`  tool/result ${event.callId}：${event.output}`)
        break
      case 'user/message':
        console.log(`  user/message ${event.content}`)
        break
    }
  }
}

// —— 第一幕：取消——会挂起的工具被超时 abort，turn 收口为 aborted ——
// 「外部」是一个 40ms 的闹钟：真产品里这一头是用户按 Esc、UI 关窗口、
// 父代理收回委派——共同点是它们都只能「请求停止」，打断不了正在跑的代码，
// 能不能停下来取决于工具体监不监听 signal（协作式取消）。
console.log('—— 第一幕：会挂起的工具被超时取消 ——')
const controller = new AbortController()
setTimeout(() => controller.abort(new Error('超时：全盘扫描超过 40ms 预算，用户不等了')), 40)
const scanModel = createMockModel([
  {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('scan_1', 'slow_scan', { scope: '整个工作区' })],
    },
    finishReason: 'tool_calls',
  },
])
const scanLog = new SessionLog()
const scanMessages = await runLoop(scanModel, registry, '全盘扫描一下工作区', {
  log: scanLog,
  preExecute: [permission],
  signal: controller.signal,
})
printMessages(scanMessages)
console.log('\n—— turn 生命周期（最后一条事件收口，之后不再有任何事件） ——')
printLifecycle(scanLog.events)
const scanEnd = scanLog.events.at(-1)
console.log(
  `日志收口：${scanEnd?.type === 'turn/end' ? `turn/end reason=${scanEnd.reason}` : '没有 turn/end（未闭合！）'}，事件总数 ${scanLog.events.length}`,
)

// —— 第二幕：可恢复——工具抛错被模型看到并绕开 ——
// fetch_stats 的 execute 抛错，错误文本作为 tool/result 回喂；模型读到了，
// 换 cached_stats 完成 turn。工具错误是对话的一部分，不是进程的事故。
console.log('\n—— 第二幕：抛错的工具被模型看到并绕开 ——')
const statsModel = createMockModel([
  {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('stats_1', 'fetch_stats', { source: '实时服务' })],
    },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('stats_2', 'cached_stats', {})],
    },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content:
        '实时统计服务 500 了，但我拿到了缓存：本周构建 12 次、成功率 91.7%。工具报错不是死路——错误文本回到我这里，换个数据源就行。',
    },
    finishReason: 'stop',
  },
])
const statsLog = new SessionLog()
const statsMessages = await runLoop(statsModel, registry, '给我看本周的构建统计', {
  log: statsLog,
  preExecute: [permission],
})
printMessages(statsMessages)
console.log('\n—— turn 生命周期 ——')
printLifecycle(statsLog.events)

// —— 第三幕：致命——模型/适配器层抛错，收口 turn/end(error) 后上抛 ——
// 对照第二幕：同样是异常，层级决定归宿。工具错误回喂（对话的一部分），
// 模型错误上抛（进程级事件）。这里用一个必然连接失败的「坏适配器」演示。
console.log('\n—— 第三幕：模型层致命错误 ——')
const brokenModel: Model = async () => {
  throw new Error('DeepSeek API 连接失败（模拟网络事故）')
}
const crashLog = new SessionLog()
try {
  await runLoop(brokenModel, registry, '随便干点什么', { log: crashLog, preExecute: [permission] })
} catch (error) {
  console.log(`循环上抛：${(error as Error).message}`)
}
printLifecycle(crashLog.events)

// —— 收束对照：三幕三种结局，turn/end 的 reason 各自陈述 ——
const outcomes = [scanLog, statsLog, crashLog].map((log) => {
  const end = log.events.findLast((event) => event.type === 'turn/end')
  return end?.type === 'turn/end' ? end.reason : '未闭合'
})
console.log(`\n三幕结局对照：${outcomes.join(' / ')}——同一个循环，三种有账可查的收场`)
