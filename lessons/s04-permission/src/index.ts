import { createMockModel, toolCall } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { registryOf } from './registry'
import { SessionLog } from './log'
import { createPermissionGuard, type AskQuestion } from './permission'
import { addTool, deleteFileTool, echoTool, moveToTrashTool, readFileTool } from './tools'

// —— 剧本化假用户：回答审批问题的「人」。这里她第一次说「不」——
// 真实产品里这一头是终端弹窗、Web UI 或 ACP 客户端，答案由真人点出来。
// 收到的问题与给出的回答都记进 asked，对话流打印完再统一回放。
const asked: { question: AskQuestion; answer: 'allow' | 'deny' }[] = []
const scriptedUser = async (question: AskQuestion): Promise<'allow' | 'deny'> => {
  const answer: 'allow' | 'deny' = 'deny' // 剧本：不放行这次删除
  asked.push({ question, answer })
  return answer
}

// 权限策略：只读与可恢复操作直接放行，不可恢复的删除要问人。
// 规则表没提的工具走默认裁决 'ask'（fail-safe），这里 add/echo 显式 allow 只是示范写法。
const permission = createPermissionGuard({
  rules: {
    read_file: 'allow',
    move_to_trash: 'allow',
    add: 'allow',
    echo: 'allow',
    delete_file: 'ask',
  },
  askUser: scriptedUser,
})

const registry = registryOf(addTool, echoTool, deleteFileTool, readFileTool, moveToTrashTool)

// —— 第一幕：模型想删文件 → 被人拒绝 → 收到拒绝文本 → 改走安全路径 ——
// 换成真模型时，「看到拒绝后改道」是模型自己读到回喂文本做出的行为。
const model = createMockModel([
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'read_file', { path: 'a.txt' })] },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call_2', 'delete_file', { path: 'a.txt', force: true })],
    },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call_3', 'move_to_trash', { path: 'a.txt' })],
    },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content:
        'a.txt 已处理：直接删除被用户拒绝，我改用回收站完成清理（可随时恢复）。权限拒绝不是死路——拒绝原因回到我这里，换个允许的工具就行。',
    },
    finishReason: 'stop',
  },
])

const log = new SessionLog()
const messages = await runLoop(model, registry, '帮我清理 a.txt：先看一眼内容，再把它处理掉', {
  log,
  preExecute: [permission],
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

// —— 第二部分：权限决策轨迹（每次调用的最终裁决与理由，放行也记） ——
console.log('\n—— 权限决策轨迹 ——')
for (const entry of permission.trace) {
  console.log(
    `${entry.tool.padEnd(14)} → ${entry.outcome === 'allow' ? '放行' : '否决'}（${entry.via}）：${entry.reason}`,
  )
}

// —— 第三部分：审批记录（假用户收到了什么问题、答了什么） ——
console.log('\n—— 审批记录 ——')
for (const { question, answer } of asked) {
  console.log(`问：${question.tool}(${JSON.stringify(question.args)}) —— ${question.reason}`)
  console.log(`答：${answer === 'allow' ? 'allow（放行这一次）' : 'deny（拒绝这一次）'}`)
}

// —— 第四部分：权限拒绝也是模型可见事实：它落在会话日志里 ——
console.log('\n—— 会话事件流（权限拒绝以 tool/result 落日志） ——')
for (const event of log.events) {
  if (event.type === 'tool/result') {
    console.log(`#${event.seq} ${event.type.padEnd(18)} → ${event.callId}：${event.output}`)
  } else if (event.type === 'tool/call') {
    console.log(`#${event.seq} ${event.type.padEnd(18)} ${event.name}(${event.arguments})`)
  } else if (event.type === 'assistant/message') {
    const calls = event.message.tool_calls?.map((c) => c.function.name).join(', ')
    console.log(`#${event.seq} ${event.type.padEnd(18)} ${calls ? `请求工具 ${calls}` : (event.message.content ?? '')}`)
  } else if (event.type === 'user/message') {
    console.log(`#${event.seq} ${event.type.padEnd(18)} ${event.content}`)
  } else {
    console.log(`#${event.seq} ${event.type.padEnd(18)} turn=${event.turn}`)
  }
}
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const requestPrefixes = log.events
  .map((event, index) => (event.type === 'assistant/message' ? index : -1))
  .filter((index) => index >= 0)
  .map((index) => SessionLog.replay(log.events.slice(0, index)).deriveMessages())
console.log(
  `宪法对拍（模型可见 = 已落日志，权限拒绝也不例外）：${model.calls.length} 次模型请求全部等于日志前缀的投影：${model.calls.every((call, k) => sameJson(call, requestPrefixes[k]))}`,
)

// —— 第二幕：deny-all 剧本——「把默认策略改成全部拒绝」就是这样的世界 ——
console.log('\n—— 第二幕：deny-all 世界 ——')
const denyAll = createPermissionGuard({ rules: { '*': 'deny' } })
const strictModel = createMockModel([
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_s1', 'read_file', { path: 'a.txt' })] },
    finishReason: 'tool_calls',
  },
  {
    message: {
      role: 'assistant',
      content: '这个会话的策略拒绝了所有工具调用（通配 * → deny），我无法读取或修改任何文件。请先放宽策略。',
    },
    finishReason: 'stop',
  },
])
const strictMessages = await runLoop(strictModel, registry, '帮我清理 a.txt', { preExecute: [denyAll] })
for (const m of strictMessages) {
  const detail =
    m.role === 'assistant' && m.tool_calls
      ? `请求工具 ${m.tool_calls.map((c) => c.function.name).join(', ')}`
      : m.role === 'tool'
        ? `工具结果：${m.content}`
        : (m.content ?? '')
  console.log(`[${m.role}] ${detail}`)
}
for (const entry of denyAll.trace) {
  console.log(
    `${entry.tool.padEnd(14)} → ${entry.outcome === 'allow' ? '放行' : '否决'}（${entry.via}）：${entry.reason}`,
  )
}
