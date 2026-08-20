import type { ChatMessage } from '@learn-dsh/mock-model'

/**
 * 会话事件：一条不可变的会话事实，判别联合按 `type` 收窄。
 * 调用方构造的事件不含 `seq`——身份由 {@link SessionLog.append} 落日志时赋予。
 * 与 dsh 的对应（packages/core/session/src/types.ts 的 SessionEventMap）：
 * 六个事件名全部同名同位；dsh 另有 step/start、step/end（本课的「步」隐含在
 * assistant/message 序列里）、assistant/chunk（流式逐块保真，本课无流式）、
 * request/header 等记录性事件。
 */
export type SessionEvent =
  | { type: 'turn/start'; turn: number }
  | { type: 'turn/end'; turn: number; reason: 'completed' }
  | { type: 'user/message'; content: string }
  /** 模型的整条输出消息；要调工具时 tool_calls 就在消息里（与 dsh 相同）。 */
  | { type: 'assistant/message'; message: ChatMessage }
  /**
   * 模型发起的一次工具调用，arguments 是未解析的原始 JSON 串。
   * 它是 trace 事实：tool_calls 已随 assistant/message 落盘，派生历史不需要它，
   * 但审计与重放需要——对应 dsh 的 tool/call（携带 turn/step/callId）。
   */
  | { type: 'tool/call'; turn: number; callId: string; name: string; arguments: string }
  /** 一次工具调用的模型可见结果；callId 与 tool/call（及消息里的 tool_call.id）配对。 */
  | { type: 'tool/result'; callId: string; output: string }

/** 已落日志的事件：append 时被赋予会话内单调递增的 `seq` 并深冻结。 */
export type LoggedEvent = SessionEvent & { seq: number }

/** 就地深冻结一个 JSON 形态的值：append-only 的「不改」靠它强制。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/**
 * append-only 会话日志：模型的记忆与真理之源。
 * 只增不改——没有 update/pop 之类的 API，事件与快照全部深冻结，
 * 「修改历史」在 JavaScript 层面就是 TypeError。
 * 模型可见的对话历史不是存出来的状态，而是 {@link deriveMessages} 从日志投影出来的视图。
 * dsh 对应 packages/core/session/src/index.ts 的 Session（那里多一层 surface 机制，
 * 压缩等改写历史的操作以 replace 节点显式入日志）。
 */
export class SessionLog {
  private readonly log: LoggedEvent[] = []
  /** 缓存的只读快照；下一次 append 使之失效（与 dsh 的 events getter 相同）。 */
  private snapshot: readonly LoggedEvent[] | undefined

  /**
   * 追加一条事件：赋予 `seq = 当前日志长度`（从 0 连续递增，与 dsh 的契约相同），
   * 深冻结后入列。
   * @param event - 调用方构造的事件（不含 seq）；嵌套内容必须是可克隆的 JSON 形态。
   * @returns 落盘后的冻结事件（seq 已赋）。
   */
  append(event: SessionEvent): LoggedEvent {
    const logged = deepFreeze({ ...structuredClone(event), seq: this.log.length }) as LoggedEvent
    this.log.push(logged)
    this.snapshot = undefined
    return logged
  }

  /**
   * 日志的只读快照。数组与每个事件（含嵌套内容）都是冻结的：
   * 取到的快照不会随后续 append 增长，改写任何历史位置都会抛 TypeError。
   */
  get events(): readonly LoggedEvent[] {
    this.snapshot ??= Object.freeze([...this.log])
    return this.snapshot
  }

  /**
   * 从事件投影模型可见的对话历史——「模型看到什么」的唯一决定者。
   * 只有产消息的三类事件投影；turn 边界与 tool/call 是 trace 事实，投影为空。
   * 每次调用都重新遍历（教学版不做缓存；dsh 按 surface 节点增量缓存）。
   * 返回新数组；数组元素是与事件共享的冻结消息对象——不可变，共享是安全的。
   * dsh 对应 packages/core/session/src/surface.ts 的 deriveEventMessage 折叠。
   */
  deriveMessages(): ChatMessage[] {
    const messages: ChatMessage[] = []
    for (const event of this.log) {
      switch (event.type) {
        case 'user/message':
          messages.push({ role: 'user', content: event.content })
          break
        case 'assistant/message':
          messages.push(event.message)
          break
        case 'tool/result':
          messages.push({ role: 'tool', content: event.output, tool_call_id: event.callId })
          break
        case 'turn/start':
        case 'turn/end':
        case 'tool/call':
          // 边界与调用事实不产消息：tool_calls 已随 assistant/message 投影，
          // 这里再投影会造成重复。dsh 的 surface 同样只收三类产消息事件。
          break
      }
    }
    return messages
  }

  /**
   * 下一个 turn 的编号，从日志派生而非内存计数——重放、fork、续写之后自然接着数。
   * dsh 对应 session invariant 里维护的 nextTurn（packages/core/session/src/invariant.ts）。
   */
  nextTurn(): number {
    let next = 1
    for (const event of this.log) {
      if (event.type === 'turn/start' || event.type === 'turn/end') next = event.turn + 1
    }
    return next
  }

  /**
   * 从边界分叉出一个新日志：历史取母日志 `boundary`（含）之前的前缀。
   * 浅历史复制——子日志与母日志共享同一批冻结事件对象，不可变性让共享免费；
   * 分叉之后两边各自 append，互不可见。
   * @param boundary - 母日志事件的 seq（闭区间）；省略表示取到最后一个事件。
   * @returns 以该前缀为历史的新日志。
   * @throws 边界越界或不是安全整数；或边界落在未闭合的 turn 内
   * （与 dsh fork 的 OPEN_TURN 拒绝同款：半截 turn 的历史不是合法的续写起点）。
   */
  fork(boundary?: number): SessionLog {
    const events = this.events
    // 空日志省略边界 → 空支线（与 dsh 相同：omitted on an empty source forks an empty child）
    if (boundary === undefined && events.length === 0) return new SessionLog()
    const end = boundary ?? events.length - 1
    if (!Number.isSafeInteger(end) || end < 0 || end >= events.length) {
      throw new Error(
        `fork 边界 ${String(end)} 不在日志范围内（合法 seq：0..${events.length - 1}，日志共 ${events.length} 个事件）`,
      )
    }
    const prefix = events.slice(0, end + 1)
    const lastTurnMark = prefix.findLast(
      (event) => event.type === 'turn/start' || event.type === 'turn/end',
    )
    if (lastTurnMark?.type === 'turn/start') {
      throw new Error(`fork 边界 ${end} 落在未闭合的 turn ${lastTurnMark.turn} 内；请在 turn 结束后分叉`)
    }
    const child = new SessionLog()
    child.log.push(...prefix)
    return child
  }

  /**
   * 重放：仅凭事件列表从零重建日志。校验 seq 从 0 连续递增——
   * 断裂的日志不是同一份历史，宁可拒绝也不静默重排。
   * @param events - 任何来源的事件序列（测试、演示、未来的持久化文件）。
   * @returns 重建出的日志；append 逐条克隆，与来源互不共享可变状态。
   * @throws 事件的 seq 与位置不连续。
   */
  static replay(events: readonly LoggedEvent[]): SessionLog {
    const log = new SessionLog()
    for (const [index, event] of events.entries()) {
      if (event.seq !== index) {
        throw new Error(`重放要求 seq 从 0 连续递增：第 ${index} 个事件带的 seq 是 ${String(event.seq)}`)
      }
      log.append(event)
    }
    return log
  }
}
