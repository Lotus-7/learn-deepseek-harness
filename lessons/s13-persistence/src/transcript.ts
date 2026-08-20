import type { ChatMessage } from '@learn-dsh/mock-model'
import type { LoggedEvent } from './log'

/** 一行 transcript 的最大宽度：超长内容截断加省略号（工具输出动辄几十行）。 */
const LINE_MAX_CHARS = 72

/** 截断一行到展示宽度。 */
function clip(text: string): string {
  const firstLine = text.split('\n')[0] ?? ''
  return firstLine.length > LINE_MAX_CHARS ? `${firstLine.slice(0, LINE_MAX_CHARS)}…` : firstLine
}

/** 参数要点的紧凑形态：name=value 串，值取 JSON 形态。 */
function argsDigest(args: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(args) as unknown
  } catch {
    return args
  }
  if (typeof parsed !== 'object' || parsed === null) return String(parsed)
  return Object.entries(parsed as Record<string, unknown>)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
}

/** 模型消息正文：有 tool_calls 时渲染调用请求，否则渲染文本。 */
function modelLine(message: ChatMessage): string {
  if (message.tool_calls && message.tool_calls.length > 0) {
    const calls = message.tool_calls
      .map((call) => `${call.function.name}(${argsDigest(call.function.arguments)})`)
      .join('；')
    return `请求工具 ${calls}`
  }
  return clip(message.content ?? '')
}

/**
 * 把事件流渲染成人类可读的 transcript：每事件一行（压缩事件加一行摘要说明）。
 * 这是「回放」的只读面——**没有一行状态是编出来的**：用户输入、模型消息、
 * 工具调用与结果、技能规程、压缩检查点，全部从事件投影，所以任何两份
 * 相同事件的日志（原实例与 resume 重建）渲染出**逐行相同**的 transcript。
 * dsh 同位立场（docs/architecture.md 的 Session log 一节）："Fork, resume,
 * transcripts, telemetry, and persistence all derive from this stream"——
 * transcript 是日志的又一个投影，不是另一份记录。
 * tool/result 事件不带工具名（只有 callId），渲染时用 tool/call 事件配对补名。
 * @param events - 任一份完整事件序列（通常来自文件扫描）。
 * @returns 人类可读行数组。
 */
export function renderTranscript(events: readonly LoggedEvent[]): string[] {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') names.set(event.callId, event.name)
  }
  const lines: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        lines.push(`── turn ${event.turn} 开始`)
        break
      case 'turn/end':
        lines.push(`── turn ${event.turn} 结束（${event.reason}）`)
        break
      case 'user/message':
        lines.push(`用户 ▸ ${clip(event.content)}`)
        break
      case 'system/message':
        lines.push(`system ▸ ${clip(event.content)}`)
        break
      case 'assistant/message':
        lines.push(`模型 ▸ ${modelLine(event.message)}`)
        break
      case 'tool/result':
        lines.push(`工具 ▸ ${names.get(event.callId) ?? event.callId} → ${clip(event.output)}`)
        break
      case 'tool/call':
        // 不单独渲染：调用请求已随 assistant/message 展示，这里只留结果行；
        // 本事件的价值在配对（callId → 工具名）与审计，不在 transcript。
        break
      case 'session/compacted':
        lines.push(
          `▸ 压缩检查点：前 ${event.shadowedCount} 条头部事实被摘要替代（估算 token ${event.tokensBefore} → ${event.tokensAfter}），被压事件仍在日志里`,
        )
        break
      default:
        break
    }
  }
  return lines
}
