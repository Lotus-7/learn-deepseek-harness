/**
 * s15 演示：用真实 npm 包组装的 mini harness 跑通 s01 的剧本——
 * add(2,3) → echo 复读 → 终答。与 s01 输出对照：行为同构，但这次驱动
 * 循环的每一行都是 @deepseek-ai/dsh-* 的生产代码。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { assembleMiniHarness, createMiniAgent, userPrompt } from './harness.ts'
import { ScriptedAdapter, textTurn, toolCallTurn } from './scripted-adapter.ts'
import { TOOL_ROSTER } from './tools.ts'

/** s01 的剧本逐字重放：先要 add，再要 echo 复读结果，最后给出回答。 */
const SCRIPT = [
  toolCallTurn('call-add', 'add', { a: 2, b: 3 }),
  toolCallTurn('call-echo', 'echo', { text: '2 + 3 = 5' }),
  textTurn('2 + 3 = 5。这是真实 dsh 包上的一次完整运转。'),
]

/** 把一条会话事件投影成一行可读 transcript（只打 transcript 级事件）。 */
function renderEvent(event: SessionEvent): string | undefined {
  switch (event.type) {
    case 'turn/start': return `── turn ${event.data.turn} 开始`
    case 'turn/end': return `── turn ${event.data.turn} 结束`
    case 'user/message': {
      const text = event.data.content.map(b => b.type === 'text' ? b.text : `<${b.type}>`).join('')
      return `[user] ${text}`
    }
    case 'assistant/message': {
      const parts = event.data.message.content.map(b => {
        if (b.type === 'text') return b.text
        if (b.type === 'tool-call') return `请求工具 ${b.name}`
        return `<${b.type}>`
      })
      return `[assistant] ${parts.join(' ｜ ')}`
    }
    case 'tool/call': return `[tool] 调用 ${event.data.name}(${event.data.arguments})`
    case 'tool/result': {
      const block = event.data.message.content[0]
      if (block?.type !== 'tool-result') return undefined
      const text = block.content.map(b => b.type === 'text' ? b.text : `<${b.type}>`).join('')
      return `[tool] 工具结果：${text}${block.isError === true ? '（出错）' : ''}`
    }
    default: return undefined // assistant/chunk、request/header 等原始级事件不打
  }
}

/** 订阅本会话的日志流并打印 transcript 行（s03 的 firehose 真身）。 */
function printTranscript(ctx: Context, session: Session): void {
  ctx.on('session/event', (subject, event) => {
    if (subject !== session) return
    const line = renderEvent(event)
    if (line !== undefined) console.log(line)
  })
}

const adapter = new ScriptedAdapter(SCRIPT)
const ctx = await assembleMiniHarness(adapter, TOOL_ROSTER)
const agent = createMiniAgent(ctx, 's15-demo')

console.log('—— 用真实 @deepseek-ai/dsh-* 包组装的 mini harness ——')
console.log(`provider: ${agent.options.provider ?? ''} / model: ${agent.options.model ?? ''}（剧本 adapter，无 API key）`)
printTranscript(agent.ctx, agent.session)

agent.followup(userPrompt('帮我算 2 + 3'))
await agent.whenIdle()

console.log('—— 模型面往返证据 ——')
console.log(`模型请求 ${adapter.requests.length} 次：`)
for (const [index, request] of adapter.requests.entries()) {
  const kinds = request.messages.map(m => `${m.role}(${m.content.length} 块)`).join(', ')
  console.log(`  第 ${index + 1} 次：${request.messages.length} 条消息（${kinds}）`)
}
const second = adapter.requests[1]?.messages.find(m => m.content.some(b => b.type === 'tool-result'))
const fed = second?.content.find(b => b.type === 'tool-result')
console.log(`第 2 次请求回喂的工具结果：${fed !== undefined ? JSON.stringify(fed) : '（缺失！）'}`)
console.log(`会话日志共 ${agent.session.events.length} 条事件（append-only，s03 的真身）`)

await ctx.fiber.dispose()
