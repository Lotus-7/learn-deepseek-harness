import { createMockModel, toolCall } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { ToolRegistry } from './registry'
import type { PreExecuteHook } from './pipeline'
import { SessionLog, type LoggedEvent } from './log'
import { addTool, deleteFileTool, echoTool } from './tools'

// 剧本：模型第一次用坏参数调 add（a 是字符串），收到校验错误后修正重试；
// 再调 delete_file 没带 force，被守卫否决，补上 force 重试成功。
// 换成真模型时，这些修正都由模型自己看到错误文本后做出。
const model = createMockModel([
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'add', { a: '两', b: 3 })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_2', 'add', { a: 2, b: 3 })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_3', 'delete_file', { path: 'a.txt' })] },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call_4', 'delete_file', { path: 'a.txt', force: true })],
    },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content: '2 + 3 = 5，a.txt 已删除。参数不合规、被守卫拦下都不是事故：错误文本会回到我这里，修正后重试即可。',
    },
    finishReason: 'stop',
  },
])

const registry = new ToolRegistry()
registry.register(addTool)
registry.register(echoTool)
registry.register(deleteFileTool)

// preExecute 守卫：delete_file 必须显式 force: true 才放行，否则否决并说明原因。
const requireForce: PreExecuteHook = (tool, args) =>
  tool.name === 'delete_file' && args.force !== true
    ? 'delete_file 需要 force: true 才能执行，请确认后带上该参数重试'
    : undefined

// —— 第一部分：s02 的剧本照常跑通，但循环里已经没有 messages 数组 ——
const log = new SessionLog()
const messages = await runLoop(model, registry, '帮我算 2 + 3，然后删掉 a.txt', {
  log,
  preExecute: [requireForce],
})

for (const m of messages) {
  const detail =
    m.role === 'assistant' && m.tool_calls
      ? `请求工具 ${m.tool_calls.map((c) => c.function.name).join(', ')}`
      : m.role === 'tool'
        ? `工具结果：${m.content}`
        : (m.content ?? '')
  console.log(`[${m.role}] ${detail}`)
}

// —— 第二部分：打印完整事件流（每行一个事件） ——
const renderEvent = (event: LoggedEvent): string => {
  switch (event.type) {
    case 'turn/start':
      return `turn=${event.turn}`
    case 'turn/end':
      return `turn=${event.turn} reason=${event.reason}`
    case 'user/message':
      return event.content
    case 'assistant/message':
      return event.message.tool_calls
        ? `请求工具 ${event.message.tool_calls.map((c) => c.function.name).join(', ')}（callId: ${event.message.tool_calls.map((c) => c.id).join(', ')}）`
        : (event.message.content ?? '')
    case 'tool/call':
      return `${event.name}(${event.arguments})`
    case 'tool/result':
      return `→ ${event.callId}：${event.output}`
  }
}
console.log('\n—— 会话事件流（append-only 真理之源） ——')
for (const event of log.events) {
  console.log(`#${event.seq} ${event.type.padEnd(18)} ${renderEvent(event)}`)
}

// —— 第三部分：从空 replay 重建，证明派生历史与运行时一致 ——
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const rebuilt = SessionLog.replay(log.events)
console.log('\n—— replay 重建 ——')
console.log(
  `重放 ${log.events.length} 个事件重建派生历史，与运行时一致：${sameJson(rebuilt.deriveMessages(), log.deriveMessages())}`,
)
// 宪法对拍：每次模型实际收到的请求，都必须等于「截至该次调用前」日志前缀的投影。
// 第 k 次（从 0 数）模型请求恰发生在第 k+1 个 assistant/message 事件落盘之前。
const requestPrefixes = log.events
  .map((event, index) => (event.type === 'assistant/message' ? index : -1))
  .filter((index) => index >= 0)
  .map((index) => SessionLog.replay(log.events.slice(0, index)).deriveMessages())
console.log(
  `宪法对拍（模型可见 = 已落日志）：${model.calls.length} 次模型请求全部等于日志前缀的投影：${model.calls.every((call, k) => sameJson(call, requestPrefixes[k]))}`,
)

// —— 第四部分：fork 出分叉会话，走向不同续写 ——
console.log('\n—— fork 分叉 ——')
console.log(`母会话共 ${log.events.length} 个事件；在末尾（turn 已闭合）分出两条支线`)
const branchA = log.fork()
const branchB = log.fork()
const modelA = createMockModel([
  { message: { role: 'assistant', content: '好的。a.txt 已删除，任务收尾。' }, finishReason: 'stop' },
])
const modelB = createMockModel([
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_a', 'add', { a: 7, b: 8 })] },
    finishReason: 'tool_calls',
  },
  { message: { role: 'assistant', content: '7 + 8 = 15。' }, finishReason: 'stop' },
])
const answerA = await runLoop(modelA, registry, '不用了，就这样收尾吧', { log: branchA })
const answerB = await runLoop(modelB, registry, '等等，再帮我算 7 + 8', { log: branchB })
console.log(`支线 A（续写「不用了，就这样收尾吧」）→ ${answerA.at(-1)?.content}`)
console.log(`支线 B（续写「等等，再帮我算 7 + 8」）→ 先调 add，得到工具结果「15」后回答：${answerB.at(-1)?.content}`)
console.log(
  `浅历史复制：支线与母日志共享同一批冻结事件对象：${log.events.every((event, i) => Object.is(branchA.events[i], event))}`,
)
console.log(
  `母会话不受分叉影响：仍是 ${log.events.length} 个事件，最后一条回答仍是「${messages.at(-1)?.content?.slice(0, 18)}…」`,
)
