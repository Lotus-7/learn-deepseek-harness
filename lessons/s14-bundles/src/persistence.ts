import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LoggedEvent, SessionEvent } from './log'
import { SessionLog } from './log'

/**
 * 教学版日志格式版本。与 dsh 的 SESSION_FORMAT_VERSION
 * （packages/core/session/src/types.ts，当前 0——单一单调整数，无 major/minor）
 * 同一个岗位：给「这份日志用哪个词汇表写的」编号，读的人不认识就整份拒绝，
 * 绝不静默降级。真码的 bump 纪律：只有结构性变化（头行形状、事件信封、
 * 核心语义）才 bump；普通新事件类型靠信封的 ignorable 标记容忍，不动版本号。
 * 教学版每个事件一行 JSON、词汇就是本目录 log.ts 的联合——版本永远是 0，
 * 但**检查本身**保留：这是「跨版本拒绝」语义的最小可跑样本。
 */
export const SESSION_FORMAT_VERSION = 0

/**
 * 会话头：日志之外的不回放元数据。对照 dsh 的 SessionHeader
 * （packages/core/session/src/types.ts）——那里还有 cwd（按项目分组存储）、
 * delegationDepth/agentPreset（子代理深度与组合预设**必须持久**，否则 resume
 * 出一个「历史里调过这些工具、现在却没装配它们」的会话）。教学版收两支
 * 与本课直接相关的谱系字段：
 * - `parentSession`：本文件从哪个会话 fork 而来（没有 = 主线）；
 * - `seedLength`：fork 时继承的前缀事件数——「哪些是父母的历史、哪些是
 *   本支自己的工作」的持久边界，回放与审计都靠它分辨。
 */
export interface SessionHeader {
  /** 写入方的日志格式版本；读方不认识就整份拒绝（见 {@link SESSION_FORMAT_VERSION}）。 */
  readonly version: number
  /** 会话 id（教学版即文件基名）。 */
  readonly id: string
  /** 创建时间（Unix 毫秒）。 */
  readonly createdAt: number
  /** fork 谱系：母会话的 id；主线会话没有。 */
  readonly parentSession?: string
  /** fork 谱系：继承自母会话的事件条数（闭边界）。 */
  readonly seedLength?: number
}

/** 头行的磁盘形态：多一个 `type: 'session'` 标记，让读者把头行与事件行区分开。 */
interface HeaderLine extends SessionHeader {
  type: 'session'
}

/** 把一条事件序列化为一行 JSONL（不含换行）。与 dsh 的 eventLines 同式：一事件一行。 */
export function eventLine(event: LoggedEvent): string {
  return JSON.stringify(event)
}

/** 解析头行：type 标记、版本、id 缺一不可；版本不认识当场拒绝。 */
function parseHeaderLine(line: string, path: string): SessionHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error(`会话文件 ${path} 的头行不是合法 JSON`)
  }
  const record = parsed as Partial<HeaderLine> | null
  if (
    typeof record !== 'object' ||
    record === null ||
    record.type !== 'session' ||
    typeof record.id !== 'string' ||
    record.id === '' ||
    typeof record.version !== 'number'
  ) {
    throw new Error(`会话文件 ${path} 的头行不是合法会话头（需要 type: 'session'、id、version）`)
  }
  if (record.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `会话文件 ${path} 的日志格式版本是 v${record.version}，本课程只读 v${SESSION_FORMAT_VERSION}——` +
        '这份日志由别的词汇表写成，拒绝解释而不是猜着读（dsh 同款：sessionFormatVersionRefusal）',
    )
  }
  const header: SessionHeader = {
    version: record.version,
    id: record.id,
    createdAt:
      typeof record.createdAt === 'number' && Number.isSafeInteger(record.createdAt) ? record.createdAt : 0,
    ...(record.parentSession !== undefined ? { parentSession: record.parentSession } : {}),
    ...(record.seedLength !== undefined ? { seedLength: record.seedLength } : {}),
  }
  return header
}

/**
 * 一个会话文件的追加句柄：append 即 write + fsync——**append 返回时这一行
 * 已穿过页缓存到达存储**，这就是本课「落账即持久」的物理含义。
 * 对照 dsh 的 JsonlSessionPersistence.appendLines
 * （packages/session/session-persistence-jsonl/src/index.ts）：open('a') →
 * writeFile → handle.sync()，同款三步；部分写失败时真码会把文件回滚到写前
 * 大小（否则重试批次会造成重复 seq），教学版单线程演示不构造这条路径，
 * 但 fsync 这一步不省——没有它，「写了」只意味着「进了内核缓冲」。
 */
export class SessionFile {
  private fd: number | undefined

  private constructor(
    /** 文件绝对路径（诊断与 fork 用）。 */
    readonly path: string,
  ) {}

  /**
   * 物化一个新会话文件：头行 + 初始事件**一次原子写入**——临时文件写完、
   * fsync、再 rename 到目标名。对照真码的 materialize（同文件）：它用
   * link()+unlink() 发布而不是 rename()，因为 link 在目标已存在时失败
   * （EEXIST），两个进程并发物化同一 id 时谁也覆盖不了谁；rename 会静默
   * 顶掉。教学版单进程演示，用 rename 已足够表达「头行要么完整存在、
   * 要么不存在，没有半行」的原子性诉求。
   * @param path - 目标文件路径（父目录会按需创建）。
   * @param header - 会话头。
   * @param events - 随物化写入的初始事件（fork 的前缀；新会话传空数组）。
   * @returns 已打开追加句柄的文件对象。
   * @throws 目标文件已存在（不覆盖既有日志——同 id 二次物化是装配错误）。
   */
  static materialize(path: string, header: SessionHeader, events: readonly LoggedEvent[]): SessionFile {
    if (existsSync(path)) {
      throw new Error(`会话文件 ${path} 已存在；要继续它请 resume，不要重建（覆盖一份 committed 日志是数据丢失）`)
    }
    mkdirSync(dirname(path), { recursive: true })
    const line: HeaderLine = { type: 'session', ...header }
    const body = [JSON.stringify(line), ...events.map(eventLine)].join('\n') + '\n'
    const tmp = `${path}.${process.pid}.tmp`
    const tmpFd = openSync(tmp, 'wx')
    try {
      writeSync(tmpFd, body)
      fsyncSync(tmpFd)
    } finally {
      closeSync(tmpFd)
    }
    renameSync(tmp, path)
    return new SessionFile(path).openAppend()
  }

  /** 打开既有文件的追加句柄（resume 之后继续写同一份日志）。 */
  private openAppend(): SessionFile {
    this.fd = openSync(this.path, 'a')
    return this
  }

  /** 便捷入口：不物化、只追加（resume 续写的场景）。 */
  static openAppend(path: string): SessionFile {
    return new SessionFile(path).openAppend()
  }

  /**
   * 追加一条事件并 fsync。事件必须已带 seq（调用方是 SessionLog.append 的
   * 产物）——文件里每行的 seq 就是它的行号减一头行，续写天然接续。
   */
  append(event: LoggedEvent): void {
    if (this.fd === undefined) throw new Error(`会话文件 ${this.path} 已关闭，不能再追加`)
    writeSync(this.fd, `${eventLine(event)}\n`)
    fsyncSync(this.fd)
  }

  /** 关闭句柄（幂等；插件卸载时挂进 effect）。 */
  close(): void {
    if (this.fd === undefined) return
    closeSync(this.fd)
    this.fd = undefined
  }
}

/** 一次扫描的结果：完整前缀 + 需要物理修复的两类残迹。 */
export interface ScanResult {
  /** 解析出的会话头。 */
  header: SessionHeader
  /** 完整、seq 连续的事件前缀（不含合成收尾）。 */
  events: LoggedEvent[]
  /** 崩溃尾巴：写了一半的行。调用方应把文件截到 truncateTo 字节。 */
  tornTail?: { truncateTo: number; droppedLines: number }
  /** 尾部未闭合 turn 需要的合成收尾事件（{@link interruptedClosers} 的产物）。 */
  closers: SessionEvent[]
}

/**
 * 只读扫描一个会话文件——「读出不修」的那半（对照真码 inspect 与 load 的分工：
 * inspect 只读、load 顺带把修复落盘）。
 *
 * **损坏分流是本课 durability 语义的核心，与 dsh 两个后端共享同一条线**：
 *
 * | 损坏位置 | 判定 | 处置 |
 * |---|---|---|
 * | 最后一个 `turn/end` 之前（committed 区） | 已经承诺过的历史坏了 | **拒绝**，带行号与期望 seq——宁可不开也不猜 |
 * | 最后一个 `turn/end` 之后（崩溃尾巴） | 上次进程死在 turn 中途 | 截到最近完整事件 + 合成收尾，**响亮警告** |
 *
 * 真码同位：JSONL 后端的 SessionLogScanner（最后一行无换行 = torn tail 忽略；
 * committed 区的坏行 / seq 断裂抛 corruption，见
 * packages/session/session-persistence-jsonl/src/format.ts）与 SQLite 后端的
 * scanRows（「the first unparsable row or seq gap after the last `turn/end`
 * marks a tolerated torn tail; the same hole in the committed region rejects」，
 * packages/session/session-persistence-sqlite/src/schema.ts）。
 *
 * 为什么「最后一个 turn/end」是分界线：turn/end 是本循环的提交点——它落盘
 * 之前，这个 turn 的所有事件都还可能被下一次重写覆盖，用户也没拿到回答；
 * 它落盘之后，这段历史就是「发生过的事实」。承诺过的东西坏了要喊，没承诺
 * 的半成品可以扔。dsh 更进一步：完整的半截 turn（所有已写行都完好、只是
 * turn/end 没来得及写）**保留**，用合成收尾把它关成一个 interrupted turn，
 * 而不是整段丢弃——教学版的 {@link interruptedClosers} 同款。
 *
 * @param path - 会话文件路径。
 * @returns 完整前缀与两类残迹（都只报告、不修盘）。
 * @throws 头行缺失/非法/版本不认识；committed 区的坏行或 seq 断裂。
 */
export function scanFile(path: string): ScanResult {
  const buffer = readFileSync(path)
  const headerEnd = buffer.indexOf(0x0a)
  if (headerEnd === -1) throw new Error(`会话文件 ${path} 没有完整头行（连第一行都没写完）`)
  const header = parseHeaderLine(buffer.subarray(0, headerEnd).toString('utf8'), path)

  // 第一遍：按行切开（记录每行起始字节与是否完整收尾），解析每行，
  // 记下最后一个 turn/end 所在行——它是 committed 区与崩溃尾巴的分界线。
  interface Row {
    start: number
    end: number
    /** 行尾有 \n（完整写完）；最后一行可能没有——写一半崩溃的残迹。 */
    complete: boolean
    event: LoggedEvent | undefined
  }
  const rows: Row[] = []
  let cursor = headerEnd + 1
  while (cursor < buffer.length) {
    const newline = buffer.indexOf(0x0a, cursor)
    const end = newline === -1 ? buffer.length : newline
    const text = buffer.subarray(cursor, end).toString('utf8')
    let event: LoggedEvent | undefined
    if (text.trim() !== '') {
      try {
        const parsed = JSON.parse(text) as Partial<LoggedEvent>
        if (typeof parsed.type === 'string' && typeof parsed.seq === 'number') {
          event = parsed as LoggedEvent
        }
      } catch {
        // 坏行留在 row 上（event 为 undefined），由分流规则裁决
      }
    }
    rows.push({ start: cursor, end, complete: newline !== -1, event })
    cursor = end + 1
  }
  let lastTurnEndRow = -1
  for (const [index, row] of rows.entries()) {
    if (row.complete && row.event?.type === 'turn/end') lastTurnEndRow = index
  }

  // 第二遍：从头做 seq 连续性检查，停在第一个坏点。
  const preserved: LoggedEvent[] = []
  for (const [index, row] of rows.entries()) {
    const event = row.event
    if (!row.complete || event === undefined || event.seq !== index) {
      const where = `第 ${index + 1} 条事件（字节 ${row.start} 起）`
      if (index <= lastTurnEndRow) {
        // committed 区：已经跨过 turn/end 承诺过的历史，坏了就是坏了。
        const detail =
          !row.complete
            ? '行尾没有换行（写入中断）'
            : event === undefined
              ? '不是合法 JSON 或缺少 type/seq'
              : `seq 不连续（期望 ${index}，实际 ${event.seq}）`
        throw new Error(
          `会话文件 ${path} 在 committed 区损坏：${where}——${detail}。` +
            '已承诺的历史不完整，拒绝打开（修复请回溯到上一个备份，而不是猜着读）',
        )
      }
      // 崩溃尾巴：从坏点起整段丢弃，报出截断点。
      const droppedLines = rows.length - index
      return {
        header,
        events: preserved,
        tornTail: { truncateTo: row.start, droppedLines },
        closers: interruptedClosers(preserved),
      }
    }
    preserved.push(event)
  }

  // 全部完好：唯一可能的残迹是「写完最后一个事件、turn/end 还没落」的未闭合 turn。
  return { header, events: preserved, closers: interruptedClosers(preserved) }
}

/**
 * 为尾部未闭合的 turn 合成收尾事件——崩溃恢复的另一半。
 * 对照 dsh 的 interruptedTurnClosers（packages/core/session/src/repair.ts）：
 * 那里给每个未配对的调用合成带错误码的 tool/result（TOOL_NOT_STARTED /
 * TOOL_OUTCOME_UNKNOWN——文本明确告诉模型「结果未知，只读或幂等才可重试，
 * 有副作用的先核对外部状态」），再补 step/end 与 turn/end(interrupted)。
 * 教学版没有 step 层，收三样：每个未配对调用一条 tool/result（结果未知
 * 的文本同款立场）+ turn/end(aborted)。**为什么不直接扔掉半截 turn**：
 * ① 里面可能有已完整落盘的模型回答，扔了就是丢已承诺的事实；② 悬空的
 * tool_calls（assistant 要了调用、没有 result）会让多数 provider 拒绝整个
 * 请求——合成收尾把账面配平，resume 才续得下去。平衡日志返回空数组。
 * @param events - 完整事件前缀。
 * @returns 需要追加的合成收尾事件（不含 seq——由日志落账时赋予）。
 */
export function interruptedClosers(events: readonly LoggedEvent[]): SessionEvent[] {
  let openTurn: number | null = null
  const pendingCallIds: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.turn
        pendingCallIds.length = 0
        break
      case 'turn/end':
        openTurn = null
        pendingCallIds.length = 0
        break
      case 'assistant/message':
        for (const call of event.message.tool_calls ?? []) pendingCallIds.push(call.id)
        break
      case 'tool/result': {
        const index = pendingCallIds.indexOf(event.callId)
        if (index >= 0) pendingCallIds.splice(index, 1)
        break
      }
      default:
        break
    }
  }
  if (openTurn === null) return []
  const closers: SessionEvent[] = pendingCallIds.map((callId) => ({
    type: 'tool/result',
    callId,
    output: '工具调用在进程崩溃前未落结果，结果未知：只读或幂等的操作可重试；可能有副作用的，先核对外部状态再决定。',
  }))
  closers.push({ type: 'turn/end', turn: openTurn, reason: 'aborted' })
  return closers
}

/** resume 的产物：修复后的完整事件、会话头与给人看的警告。 */
export interface ResumeOutcome {
  /** 会话头（谱系信息在：parentSession / seedLength）。 */
  header: SessionHeader
  /** 前缀 + 合成收尾：可直接 {@link SessionLog.replay} 的完整事件序列。 */
  events: LoggedEvent[]
  /** 给人看的警告（崩溃尾巴被截、半截 turn 被合成收尾）；空数组 = 文件本来就干净。 */
  warnings: string[]
}

/**
 * 恢复一个会话：扫描 → 物理修复（截掉崩溃尾巴、追加合成收尾）→ 返回完整事件。
 * 这是「读出且修盘」的整半（对照真码 load：torn tail 截断 + closers 落盘走
 * backend.commitRepair——两步 fsync，不要求原子）。修复**必须落盘**而不只修
 * 内存：否则每次打开都修一遍，崩溃残迹永远在场；截到最近完整事件之后，
 * 文件重新成为「每行完整、seq 连续」的合法 append 起点。
 * @param path - 会话文件路径。
 * @returns 修复后的事件序列与警告。
 * @throws 头行非法或 committed 区损坏（见 {@link scanFile}）。
 */
export function resumeSession(path: string): ResumeOutcome {
  const scan = scanFile(path)
  const warnings: string[] = []
  let events = scan.events
  if (scan.tornTail !== undefined) {
    truncateSync(path, scan.tornTail.truncateTo)
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    warnings.push(
      `崩溃尾巴：丢弃最后 ${scan.tornTail.droppedLines} 行未写完的残迹，文件已截到字节 ${scan.tornTail.truncateTo}（最近完整事件）`,
    )
  }
  if (scan.closers.length > 0) {
    const file = SessionFile.openAppend(path)
    try {
      // 合成收尾在这里被赋 seq 并落盘：seq 接着前缀最后一个事件递增。
      const log = SessionLog.replay(events)
      for (const closer of scan.closers) file.append(log.append(closer))
      events = [...log.events]
    } finally {
      file.close()
    }
    warnings.push(`未闭合 turn：追加 ${scan.closers.length} 条合成收尾（未配对调用补 tool/result + turn/end(aborted)）`)
  }
  return { header: scan.header, events, warnings }
}

/** fork 到新文件的产物。 */
export interface ForkOutcome {
  /** 支线会话头（带 parentSession 与 seedLength 谱系）。 */
  header: SessionHeader
  /** 支线继承的前缀事件（= 母文件边界前全部事件）。 */
  events: LoggedEvent[]
  /** 支线文件（已物化、句柄已开，可继续追加）。 */
  file: SessionFile
}

/**
 * 从一个会话文件分叉出另一个会话文件：前缀复制到边界（含），之后两边独立增长。
 * 边界校验直接复用内存版 {@link SessionLog.fork}——越界、非安全整数、
 * 落在未闭合 turn 内的边界全部同款拒绝（与 dsh 的 SessionStore.fork 同位：
 * OPEN_TURN——半截 turn 不是合法的续写起点）。谱系写进支线头：
 * parentSession 记母会话、seedLength 记继承条数——真码 README 的原话：
 * "Persisting this boundary lets resume and replay distinguish parent history
 * from child work"。
 * @param sourcePath - 母会话文件。
 * @param boundary - 母日志事件的 seq（闭区间）；省略 = 取到最后一个事件。
 * @param targetPath - 支线文件路径。
 * @param childId - 支线会话 id。
 * @returns 支线头、前缀事件与已打开的支线文件。
 */
export function forkSessionFile(
  sourcePath: string,
  boundary: number | undefined,
  targetPath: string,
  childId: string,
): ForkOutcome {
  const scan = scanFile(sourcePath)
  // 母文件若有崩溃尾巴，fork 只取完整前缀——支线不继承残迹（母文件的修复
  // 是 resume 的职责；这里按「读到什么前缀就分什么」的只读语义走）。
  const childLog = SessionLog.replay(scan.events).fork(boundary)
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: childId,
    createdAt: Date.now(),
    parentSession: scan.header.id,
    seedLength: childLog.events.length,
  }
  const file = SessionFile.materialize(targetPath, header, childLog.events)
  return { header, events: [...childLog.events], file }
}

/**
 * 建一个演示/测试用的临时目录（系统临时目录下、前缀唯一）。
 * 用临时目录而不是仓内路径：演示可重复跑、不污染仓库；测试用它做确定性清理
 * （afterEach rmSync），断言只看目录内的相对结构，不依赖任何具体路径。
 */
export function makeScratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 递归删除一个临时目录（不存在则忽略——清理是幂等的）。 */
export function removeScratchDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
