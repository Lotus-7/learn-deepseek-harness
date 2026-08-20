import type { ChatMessage } from '@learn-dsh/mock-model'
import type { LoggedEvent, SessionEvent, SessionLog } from './log'

/**
 * 可注入的摘要器：把被压缩的头部消息压成一段文本。
 * 演示与测试用 {@link deterministicSummarize}（确定性，不依赖真模型）；
 * 真模型课把它换成一次真实的 LLM 调用——压缩器对摘要质量一无所知，
 * 它只负责「什么时候压、压哪些、账怎么记」。dsh 对应
 * packages/compaction/compaction-basic/src/index.ts 的 summarize()：
 * BasicCompactionEngine 唯一的子类定制钩子（「Override this sole hook for a
 * template or remote summarizer」），默认实现走 ctx.llm.stream()。
 */
export type Summarize = (messages: readonly ChatMessage[]) => Promise<string>

/** 组装压缩策略的选项，挂在 runLoop 的 `compaction` 参数下（cordis.yml 的同位旋钮）。 */
export interface CompactionOptions {
  /** 触发阈值（估算 token）：派生历史超过它，就在下一个步骤边界压缩。 */
  threshold: number
  /** 尾部窗口：最近 N 条派生消息原样保留（dsh 的 retainTokens 是按 token 预算保留，教学版按条数）。 */
  keepTail: number
  /** 摘要器：见 {@link Summarize}。 */
  summarize: Summarize
}

/** 每条消息的固定估算开销：role 标记与消息结构的近似成本。 */
const MESSAGE_OVERHEAD = 4

/** CJK 表意文字（含日文假名、谚文）：教学近似按 1 字 ≈ 1 token。 */
const CJK_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu

/**
 * 估算一段文本的 token 数——**教学近似，不是分词器**：
 * 中文（CJK）按 1 字 ≈ 1 token 计，其余文本按 1 词 ≈ 1 token 计
 * （空格与标点不计）。真产品的口径来自 tokenizer 或 provider 上报的用量：
 * dsh 把它做成独立的 token-meter 服务（packages/llm/token-meter），
 * compaction-basic 只消费 `ctx.tokenMeter.measure(session)` 的测量结果。
 * @param text - 任意文本（消息内容、工具参数串）。
 * @returns 估算 token 数；对同样输入恒定不变（测试与多级压缩都依赖确定性）。
 */
export function estimateTextTokens(text: string): number {
  let cjk = 0
  const rest = text.replace(CJK_RE, () => {
    cjk += 1
    return ' '
  })
  const words = rest.split(/\s+/).filter((word) => word !== '').length
  return cjk + words
}

/**
 * 估算一段派生历史的 token 数（同样只是字符近似）。
 * 每条消息加固定开销 {@link MESSAGE_OVERHEAD}；assistant 的 tool_calls
 * 按工具名 + 原始参数串套用同一文本规则；tool 消息的 tool_call_id 忽略。
 * @param messages - 模型可见的派生历史（或它的任意前缀/后缀）。
 * @returns 估算 token 总数。
 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += MESSAGE_OVERHEAD + estimateTextTokens(message.content ?? '')
    for (const call of message.tool_calls ?? []) {
      total += 1 + estimateTextTokens(call.function.name) + estimateTextTokens(call.function.arguments)
    }
  }
  return total
}

/**
 * 压缩检查点的前言与框架：告诉模型「这段摘要是既定背景，别复述、直接继续」。
 * 框架标签 <compacted-summary> 与 dsh 同名同用途——
 * packages/compaction/compaction-basic/src/summarizer.ts 的 frameSummary()
 * 用同样的标签对包裹摘要，并让下一轮摘要指令能认出「这是上一代的检查点」。
 */
const CHECKPOINT_PREAMBLE =
  '以下是本会话更早内容的自动摘要。把它当作既定背景，不要复述它，直接在其后的消息基础上继续任务。'

/** 组装最终落账的检查点文本：前言 + 标签对包裹的摘要（框架策略属于 harness，不属于摘要器）。 */
function frameCheckpoint(summary: string): string {
  return `${CHECKPOINT_PREAMBLE}\n<compacted-summary>\n${summary}\n</compacted-summary>`
}

/**
 * 摘要的形态选择：**user 消息**，不是 system。三点理由：
 * ① 派生历史是按位置投影的，摘要出现在压缩点所在的位置——system 语义上是
 *    「全局指令」，插在对话中段名不副实；② OpenAI 风格的 API 里中段 system
 *    本就是非常规用法；③ dsh 的替换节点同样是 user/message
 * （packages/compaction/compaction/src/types.ts：compaction/summary 事件只落日志，
 * 真正的表面替换由紧随其后的 user/message 完成）。派生端在这里投影它。
 */
export function summaryMessage(summary: string): ChatMessage {
  return { role: 'user', content: summary }
}

/**
 * 把尾部窗口的切点挪到「配对安全」的位置：切点后第一条消息不能是 tool 结果——
 * 它的 assistant tool_calls 消息若被划进头部，派生历史就会出现没有调用方的
 * tool 消息，多数 API 直接拒绝。教学版一条规则就够（本循环里 tool 结果总是
 * 紧跟其 assistant 消息）：切点落在 tool 消息上就整体左移，把这对消息一起
 * 划进尾部。dsh 的完整解法是 packages/compaction/compaction/src/tool-pairing.ts：
 * 对整个表面维护「未闭合 tool-call 计数」，切点两侧都必须计数归零。
 * @param messages - 当前派生历史。
 * @param keepTail - 想保留的尾部条数。
 * @returns 头部切点下标（头部 = messages.slice(0, index)，尾部 = 其后）；
 * 头部为空返回 0（无可压缩的头部）。
 */
function pairingSafeSplit(messages: readonly ChatMessage[], keepTail: number): number {
  let split = Math.max(0, messages.length - keepTail)
  while (split > 0 && messages[split]!.role === 'tool') split -= 1
  return split
}

/**
 * 压缩器：预算超阈值时，把头部消息交给摘要器，产出一条 `session/compacted`
 * 事件写进日志——**压缩本身是事件**，日志依旧 append-only；被压掉的消息
 * 没有被删除，只是不再投影（「丢历史」与「压历史」的区别就在这里）。
 * 派生历史从压缩点起 = 保留的规程 + summary + 尾部窗口
 * （见 SessionLog.deriveMessages）。
 *
 * **s12 规程豁免**：头部里的 system 消息（技能 instructions）不进摘要输入、
 * 不计入 shadowedCount——规程持续生效，摘要器只改写事实。dsh 的同位立场：
 * compaction-basic 的摘要器前缀复用会话自己的 system 与工具表（命中
 * provider 的 KV 缓存），system prompt 从不在被替换的表面里
 * （packages/compaction/compaction-basic/src/summarizer.ts）。
 *
 * 触发语义：**每个步骤边界至多压一次**；压完仍超阈值不当场连压
 * （dsh 会按 compactionRetries 重试并在耗尽时报错），下一个边界自然再评——
 * 于是「阈值调到极小」时会看到跨边界的多级压缩：摘要的摘要。
 *
 * 三类放弃（不落事件、返回 false，静默但可从「日志里没有 session/compacted」审计）：
 * ① 配对安全切点后头部为空——整个历史都是尾部，没有可压的对象
 * （dsh 对应 selectCompactableRange 的 keepFromIdx === 0 → null）；
 * ② 头部剔除规程后没有可压的事实——全部头部都是 system，压无可压；
 * ③ 摘要（含框架）不比被压掉的头部小——压缩必须真的变小才有意义
 * （dsh 在这里选择报错拒绝：「summary is not smaller than the shadowed content」）。
 *
 * @param log - 会话日志：读派生历史、落压缩事件。
 * @param options - 阈值、尾部窗口与摘要器。
 * @param append - 落账通道（s08 起可选）：缺省直接 log.append；插件世界传
 *   session 服务的 append——压缩事件与其它事实一样「落账即广播 session/event」，
 *   不经它的压缩会成为广播流里看不见的事实（测试钉住）。
 * @returns 是否真的压缩了一次。
 */
export async function maybeCompact(
  log: SessionLog,
  options: CompactionOptions,
  append: (event: SessionEvent) => LoggedEvent = (event) => log.append(event),
): Promise<boolean> {
  const messages = log.deriveMessages()
  const tokensBefore = estimateTokens(messages)
  if (tokensBefore <= options.threshold) return false

  const split = pairingSafeSplit(messages, options.keepTail)
  if (split === 0) return false
  const head = messages.slice(0, split)
  const tail = messages.slice(split)

  // 规程豁免（s12）：system 消息留在头部的原位继续生效，摘要只接管事实。
  const keptInstructions = head.filter((message) => message.role === 'system')
  const shadowed = head.filter((message) => message.role !== 'system')
  if (shadowed.length === 0) return false

  const summary = frameCheckpoint(await options.summarize(shadowed))
  if (estimateTokens([summaryMessage(summary)]) >= estimateTokens(shadowed)) return false

  const tokensAfter = estimateTokens([...keptInstructions, summaryMessage(summary), ...tail])
  append({
    type: 'session/compacted',
    summary,
    shadowedCount: shadowed.length,
    tokensBefore,
    tokensAfter,
  })
  return true
}

/** 摘要事实条目的字符上限：保证长头部压出来的摘要有界（多级压缩靠它收敛）。 */
const FACT_MAX_CHARS = 40

/** 摘要最多保留的事实条数：超出时保留最早的 2 条与最近的若干条，中间显式省略。 */
const FACT_LIMIT = 8

/** 数字事实的收集上限：只收对话正文的数字，按出现顺序去重截断（日志输出全是数字噪声）。 */
const NUMBER_LIMIT = 12

/**
 * 确定性摘要器（演示与测试专用）：机械地保留每条消息的要点首行 + 对话正文的数字事实。
 * 它不「读懂」对话——数字原样保留是为了让「压缩后模型仍能引用早期事实」的
 * 演示无懈可击（dsh 的摘要指令同样要求「Preserve exact ... numeric values」）；
 * 只从用户/助手正文收集数字、跳过工具输出，是因为日志类输出满是数字噪声，
 * 教学摘要器不会判断哪个重要就干脆不收——真模型摘要器会。
 * 真模型课把它整体换成一次真实的 LLM 调用（dsh 的默认实现见
 * packages/compaction/compaction-basic/src/summarizer.ts：一次性 stream 调用，
 * 前缀复用会话自己的 system 与工具表以命中 provider 的 KV 缓存）。
 * @param messages - 被压缩的头部消息。
 * @returns 确定性的摘要文本（同样输入恒定输出）。
 */
export async function deterministicSummarize(messages: readonly ChatMessage[]): Promise<string> {
  const facts: string[] = []
  const numbers: string[] = []
  const seenNumbers = new Set<string>()
  const clip = (text: string): string => (text.length > FACT_MAX_CHARS ? `${text.slice(0, FACT_MAX_CHARS)}…` : text)
  const harvest = (content: string): void => {
    for (const number of content.match(/\d+(?:\.\d+)?/g) ?? []) {
      if (numbers.length >= NUMBER_LIMIT) return
      if (!seenNumbers.has(number)) {
        seenNumbers.add(number)
        numbers.push(number)
      }
    }
  }

  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls) {
      facts.push(`助手调用工具 ${message.tool_calls.map((call) => call.function.name).join('/')}`)
      continue
    }
    const content = message.content ?? ''
    if (content === '') continue
    const label = message.role === 'user' ? '用户' : message.role === 'tool' ? '工具结果' : '助手'
    facts.push(`${label}：${clip(content.split('\n')[0] ?? '')}`)
    if (message.role !== 'tool') harvest(content)
  }

  const shown =
    facts.length <= FACT_LIMIT
      ? facts
      : [...facts.slice(0, 2), `……（省略 ${facts.length - FACT_LIMIT} 条）……`, ...facts.slice(FACT_LIMIT - 2)]
  const parts = [
    `早期对话共 ${messages.length} 条消息的摘要。`,
    numbers.length > 0 ? `数字事实：${numbers.join('、')}。` : '',
    ...shown.map((fact, index) => `${index + 1}. ${fact}`),
  ]
  return parts.filter((part) => part !== '').join('\n')
}
