import type { ChatMessage } from '@learn-dsh/mock-model'

/**
 * 一个 turn 为什么结束——turn/end 的 reason 联合。
 * s03 只有 completed；本课按「结束的方式」扩出三支：completed（模型给出回答）、
 * aborted（外部取消）、error（模型/适配器层致命错误）。
 * dsh 对应 packages/core/session/src/types.ts 的 TurnEndReasonMap：那是一个
 * merge-extensible 的 interface——completed / aborted / blocked / error /
 * max-tokens / interrupted，每支自带结构化事实（aborted 携带取消原因、error 携带
 * LlmFailure），插件用声明合并往里加变体。教学版一支一个字符串字面量，扩展方式
 * 就是往这个联合里加字面量——方向相同：**结束方式是开放集合**，消费端（审计、
 * 重放、fork 判断）按 reason 分支，而不是拿「有没有 turn/end」猜。
 */
export type TurnEndReason = 'completed' | 'aborted' | 'error'

/**
 * 会话事件：一条不可变的会话事实，判别联合按 `type` 收窄。
 * 调用方构造的事件不含 `seq`——身份由 {@link SessionLog.append} 落日志时赋予。
 * 与 dsh 的对应（packages/core/session/src/types.ts 的 SessionEventMap）：
 * 六个事件名全部同名同位；dsh 另有 step/start、step/end（本课的「步」隐含在
 * assistant/message 序列里）、assistant/chunk（流式逐块保真，本课无流式）、
 * request/header 等记录性事件。
 * s06 新增 session/compacted：压缩本身也是事件（见该分支注释）。
 * s12 新增 system/message：技能 instructions 的注入事实（见该分支注释）。
 */
export type SessionEvent =
  | { type: 'turn/start'; turn: number }
  | { type: 'turn/end'; turn: number; reason: TurnEndReason }
  | { type: 'user/message'; content: string }
  /**
   * s12 技能注入事实：一段从此长期生效的 system 级指令（技能 instructions）。
   * 与 user/message 的区别不在「谁写的」而在**有效期**：user 消息是一次性
   * 输入，进头部就会被摘要替代；system/message 投影出的消息是「当前生效的
   * 规程」，{@link SessionLog.deriveMessages} 的压缩规则**永不把它划进被
   * 摘要替代的头部**（见 session/compacted 分支注释）——规程与事实不同，
   * 摘要器无权改写规程。
   * dsh 的对应形态是 user/message 事件 + source 元数据：真仓的技能注入
   * （tool-skill 的 loader 结果与目录发布）都走 createUserMessage，靠
   * source.kind（'skill-invocation' / 'skill-catalog'）区分语义；system
   * prompt 由独立的 systemPrompt 服务在每步请求组装（docs/architecture.md
   * 的 Turn flow：assemble prompt sections）。教学版没有请求级组装层，
   * 选 system 消息承载规程——「角色即语义」，压缩投影端按角色区分即可；
   * 代价是对话中段的 system 在部分 API 上是非常规用法（真仓因此不这么做，
   * README「看真码」细讲）。
   */
  | { type: 'system/message'; content: string }
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
  /**
   * s06 压缩事实：一次已完成的上下文压缩。它同时是**账目**与**投影替换指令**：
   * - 账目：summary 是落账的完整检查点文本（含前言），shadowedCount/tokens* 供
   *   审计与演示对照压缩前后规模；
   * - 投影指令：{@link SessionLog.deriveMessages} 遇到它，就把**此前投影出的
   *   前 shadowedCount 条非 system 消息**（被摘要替代的头部事实）原地换成
   *   一条 summary——**被压掉的事件没有被删除**，日志依旧 append-only，只是
   *   它们不再进入模型可见历史（「丢历史」与「压历史」的区别）。
   *   s12 起头部里的 system 消息（技能 instructions）**不参与替换**：规程
   *   从加载起持续生效，摘要器只被授权改写「发生过的事实」，没有授权改写
   *   「应当遵守的规程」——压缩后技能 instructions 仍在派生历史里（测试钉住）。
   * dsh 对应 packages/compaction/compaction/src/types.ts 的 compaction/* 事件
   * （start/summary/end 三段加锁的事务 + 免模型修剪的 compaction/prune 影子价格）。
   * 教学版单线程循环不需要锁，把三段折叠成一个事件；dsh 的表面替换由带
   * surfaceOp replace 的 user/message 事件显式完成（packages/core/session/src/surface.ts），
   * 教学版由派生规则承担同一职责。
   */
  | {
      type: 'session/compacted'
      /** 落账的检查点文本（前言 + <compacted-summary> 框架 + 摘要），就是模型看到的那条消息。 */
      summary: string
      /** 被摘要替代的头部**非 system**消息条数（system 规程保留，见上方投影语义）。 */
      shadowedCount: number
      /** 压缩前的派生历史估算 token（触发依据，教学近似）。 */
      tokensBefore: number
      /** 压缩后的派生历史估算 token（summary + 尾部窗口）。 */
      tokensAfter: number
    }

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
   * 产消息的事件投影；turn 边界与 tool/call 是 trace 事实，投影为空。
   * **s06 压缩规则**：遇到 `session/compacted` 事件，把此前投影的前
   * shadowedCount 条消息换成一条 summary（user 形态，选择理由见
   * src/compaction.ts），尾部窗口与其后的消息照常投影——派生历史
   * 从压缩点起 = summary + 尾部窗口。每次调用都重新遍历，所以重放整份日志
   * （{@link SessionLog.replay}）得到同样的压缩视图；而在压缩事件**之前**
   * fork 出的支线看不到它，派生出的是未压缩的完整历史——历史没有丢，丢的只是视图。
   * **s12 修订**：被替换的头部只数**非 system**消息——技能 instructions
   * （system/message 投影出的规程）在压缩后原位保留，summary 插在最后一条
   * 被替代消息的位置。dsh 的同位立场：压缩摘要器的前缀复用会话自己的
   * system（packages/compaction/compaction-basic/src/summarizer.ts），system
   * prompt 从不进被替换的表面。
   * 每次调用都重新遍历（教学版不做缓存；dsh 按 surface 节点增量缓存，
   * 替换以 surfaceOp replace 显式入账，见 packages/core/session/src/surface.ts）。
   * 返回新数组；数组元素是与事件共享的冻结消息对象——不可变，共享是安全的。
   */
  deriveMessages(): ChatMessage[] {
    const messages: ChatMessage[] = []
    for (const event of this.log) {
      switch (event.type) {
        case 'user/message':
          messages.push({ role: 'user', content: event.content })
          break
        case 'system/message':
          messages.push({ role: 'system', content: event.content })
          break
        case 'assistant/message':
          messages.push(event.message)
          break
        case 'tool/result':
          messages.push({ role: 'tool', content: event.output, tool_call_id: event.callId })
          break
        case 'session/compacted': {
          // 压缩点：把投影的前 shadowedCount 条**非 system**消息（被摘要替代的
          // 头部事实）换成一条 summary（user 形态），其后已投影的尾部窗口与
          // system 规程原样保留。尾部消息产自更早的事件（事件级投影），所以不能
          // 「清空到压缩点」——那会把尾部一起丢掉；替换的粒度必须落在消息条数上，
          // 与压缩器切分头部时一致。不是修改历史——事件照旧在日志里，只是不再投影。
          let remaining = event.shadowedCount
          const rebuilt: ChatMessage[] = []
          for (const message of messages) {
            if (remaining > 0 && message.role !== 'system') {
              remaining -= 1
              // summary 落在最后一条被替代消息的位置：规程在前、摘要接管事实、
              // 尾部窗口续上——三条段落的顺序与压缩器记账的 tokensAfter 一致。
              if (remaining === 0) rebuilt.push({ role: 'user', content: event.summary })
              continue
            }
            rebuilt.push(message)
          }
          messages.length = 0
          messages.push(...rebuilt)
          break
        }
        case 'turn/start':
        case 'turn/end':
        case 'tool/call':
          // 边界与调用事实不产消息：tool_calls 已随 assistant/message 投影，
          // 这里再投影会造成重复。dsh 的 surface 同样只收产消息事件。
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
