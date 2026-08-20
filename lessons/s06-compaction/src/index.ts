import { createMockModel, toolCall, type ChatMessage } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { registryOf } from './registry'
import { SessionLog, type LoggedEvent } from './log'
import { createPermissionGuard } from './permission'
import { deterministicSummarize, estimateTokens, type CompactionOptions } from './compaction'
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
} from './tools'

// s04 权限层与 s05 恢复层照常在场（复制前进：能力只增不减），本课聚焦它们上面的预算。
// 演示工具都在允许清单里：压缩不是权限问题，别让审批戏份抢戏。
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
    search_logs: 'allow',
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
  searchLogsTool,
)

// 压缩策略：阈值用 estimateTokens 的估算口径（教学近似），尾部窗口保留最近 4 条。
// 摘要器是注入的——这里用确定性摘要器；真模型课把它换成一次真实的 LLM 调用，
// 压缩器本身一行都不用改（这就是依赖注入的边界：策略归 harness，摘要归模型）。
const compaction: CompactionOptions = {
  threshold: 700,
  keepTail: 4,
  summarize: deterministicSummarize,
}

/** 打印一段派生历史：模型视角的对话流。工具结果只显示首行（完整文本模型都看得到，打印截断）。 */
function printMessages(messages: ChatMessage[]): void {
  for (const m of messages) {
    const lines = (m.content ?? '').split('\n')
    const detail =
      m.role === 'assistant' && m.tool_calls
        ? `请求工具 ${m.tool_calls.map((c) => c.function.name).join(', ')}`
        : m.role === 'tool'
          ? `工具结果：${lines[0]}${lines.length > 1 ? ` …（后 ${lines.length - 1} 行略）` : ''}`
          : (m.content ?? '')
    console.log(`[${m.role}] ${detail}`)
  }
}

/** 打印一个日志的事件流：压缩事件也在账上，这是「账本」的全貌。 */
function printEvents(events: readonly LoggedEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        console.log(`turn ${event.turn} start`)
        break
      case 'turn/end':
        console.log(`turn ${event.turn} end（reason: ${event.reason}）`)
        break
      case 'session/compacted':
        console.log(
          `  session/compacted：压掉 ${event.shadowedCount} 条头部消息，估算 ${event.tokensBefore} → ${event.tokensAfter} token`,
        )
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
        console.log(`  tool/result ${event.callId}：${event.output.slice(0, 40)}${event.output.length > 40 ? '…' : ''}`)
        break
      case 'user/message':
        console.log(`  user/message ${event.content}`)
        break
    }
  }
}

const log = new SessionLog()

// —— 第一幕：长对话把预算推过阈值（本幕还压不到，先攒账） ——
// 用户在第一条消息里埋下早期事实「47 台节点」；两次 search_logs 往返各带回
// 24 行日志——派生历史的估算 token 就是被这些工具结果推上去的（上下文的大头
// 从来不是用户输入，是工具输出）。
console.log('—— 第一幕：多轮工具往返把预算推过阈值 ——')
const turnOneModel = createMockModel([
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'search_logs', { query: 'timeout' })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'search_logs', { query: 'restart' })] },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content: '两种模式各命中 24 行。timeout 的延迟随 svc 编号走高，restart 集中在 svc-01，初步判断它过载引发级联重启。',
    },
    finishReason: 'stop',
  },
])
await runLoop(
  turnOneModel,
  registry,
  '我们的生产集群一共 47 台节点，最近超时报警很多。帮我从部署日志里分别查 timeout 和 restart 两种模式，给个初步判断。',
  { log, preExecute: [permission], compaction },
)
const afterTurnOne = log.deriveMessages()
const turnOneCompactions = log.events.filter((event) => event.type === 'session/compacted').length
console.log(
  `第一幕结束：派生历史 ${afterTurnOne.length} 条，估算 ${estimateTokens(afterTurnOne)} / ${compaction.threshold} token${
    turnOneCompactions === 0 ? '（未到阈值，本幕没有压缩）' : `（本幕已压缩 ${turnOneCompactions} 次）`
  }`,
)

// —— 第二幕：继续排查，步骤边界触发压缩 ——
// 压缩检查点在每个步骤边界（上一步结果落账后、下一次模型请求发出前）评估：
// 第三条 search_logs 的结果落账后预算越过 700，循环先把头部换成一条
// session/compacted 事件再发下一次请求——模型看到的历史已经变短了。
console.log('\n—— 第二幕：超阈值触发压缩 ——')
const turnTwoModel = createMockModel([
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('t3', 'search_logs', { query: 'upstream_reset' })] },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content: 'upstream_reset 与 restart 的分布重合，判断坐实：上游依赖反复重置连接。建议对 svc-01 的上游做限流并观察 restart 曲线。',
    },
    finishReason: 'stop',
  },
])
await runLoop(turnTwoModel, registry, '继续深挖：再查一下 upstream_reset 的日志。', {
  log,
  preExecute: [permission],
  compaction,
})

const compacted = log.events.findLast((event) => event.type === 'session/compacted')
if (compacted?.type !== 'session/compacted') throw new Error('演示剧本没有触发压缩：检查阈值与工具输出规模')
// 用日志前缀的重放对照压缩瞬间的派生规模——审计就是这么做的：
// 只凭账本（不需要内存状态）重建「压缩那一刻模型看到的历史」。
const beforeCount = SessionLog.replay(log.events.slice(0, compacted.seq)).deriveMessages().length
const afterCount = SessionLog.replay(log.events.slice(0, compacted.seq + 1)).deriveMessages().length
console.log(
  `压缩事件落账：压掉头部 ${compacted.shadowedCount} 条，估算 ${compacted.tokensBefore} → ${compacted.tokensAfter} token（阈值 ${compaction.threshold}）`,
)
console.log(`派生历史：${beforeCount} 条 → ${afterCount} 条。摘要内容：`)
console.log(compacted.summary)
console.log('\n压缩后模型实际收到的请求（turn 2 第二次调用，第一条就是摘要）：')
printMessages(turnTwoModel.calls[1]!)
console.log('—— 47 台节点的原文已不在模型输入里，只剩摘要里的数字事实')

// —— 第三幕：模型仍引用早期事实作答 ——
console.log('\n—— 第三幕：压缩后，模型仍引用早期事实 ——')
const turnThreeModel = createMockModel([
  {
    message: {
      role: 'assistant',
      content: '我们的集群一共 47 台节点——这个数字来自开场的背景摘要，原文早已被压缩掉，但事实还在。',
    },
    finishReason: 'stop',
  },
])
await runLoop(turnThreeModel, registry, '顺便确认一下：我们的集群一共多少台节点来着？', {
  log,
  preExecute: [permission],
  compaction,
})
const turnThreeRequest = turnThreeModel.calls[0]!
console.log(`第三幕模型的完整输入（${turnThreeRequest.length} 条，估算 ${estimateTokens(turnThreeRequest)} token）：`)
printMessages(turnThreeRequest)
const finalAnswer = log.deriveMessages().at(-1)
console.log(`模型的回答：${finalAnswer?.content ?? ''}`)

// —— 收束：丢的是视图，不是历史 ——
// 日志依旧 append-only：被压掉的消息一条都没删，还在事件流里；
// 重放整份日志重建出同样的压缩视图；在压缩点之前 fork 的支线
// 派生出的是未压缩的完整历史——可审计、可回放、可分叉，三件事一起成立。
console.log('\n—— 收束：丢的是视图，不是历史 ——')
printEvents(log.events)
const userMessageCount = log.events.filter((event) => event.type === 'user/message').length
console.log(
  `日志共 ${log.events.length} 个事件（user/message 事件 ${userMessageCount} 个，一个都没删）；当前派生历史 ${log.deriveMessages().length} 条`,
)
const replayed = SessionLog.replay(log.events)
console.log(
  `重放整份日志重建派生历史：${replayed.deriveMessages().length} 条，与原日志一致 = ${replayed.deriveMessages().length === log.deriveMessages().length}`,
)
// fork 必须落在闭合的 turn 边界（s03 的规矩）：从压缩发生前最后一个 turn/end 分叉，
// 支线派生出的是未压缩的完整历史——压缩只影响它所在的那条世界线。
const lastTurnEndBeforeCompaction = log.events
  .slice(0, compacted.seq)
  .findLast((event) => event.type === 'turn/end')
if (lastTurnEndBeforeCompaction === undefined) throw new Error('演示剧本里压缩点之前没有闭合的 turn')
const child = log.fork(lastTurnEndBeforeCompaction.seq)
console.log(
  `从压缩前最后一个 turn/end（seq=${lastTurnEndBeforeCompaction.seq}）fork：支线派生历史 ${child.deriveMessages().length} 条——分叉自压缩前的世界，看到的是未压缩的完整历史`,
)
