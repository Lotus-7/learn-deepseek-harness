import type { FsService } from './fs-service'

/**
 * 统一执行世界的 Service Definition：fs 与 subprocess 两面共用一个部署身份。
 *
 * s09 结尾引了 dsh 的一句话：「Filesystem and subprocess providers share one
 * execution world, so pointing them at a remote sandbox moves Bash, PTY, and
 * LSP with them, with no provider forks」。本文件把那句话里的「execution
 * world」做成显式接口：一个 {@link ExecutionWorld} 同时是文件系统（s09 的
 * {@link FsService} 契约原样继承）和进程世界（`spawn`），换掉这一个对象，
 * 依赖它的全部工具整体搬到另一个部署——本机、远端沙箱、或进程内虚拟机。
 *
 * dsh 真码的对应形态是**两个 seam + 一条约定**：`ctx.fs`（packages/fs/fs）
 * 与 `ctx.subprocess`（packages/subprocess/subprocess）各自是完整的
 * Service Definition，"Providers mounted together must describe the same path
 * namespace, executables, processes, and terminal sessions"（决策笔记
 * .agents/notes/implemented/architecture/2026-07-28-portable-execution-world-
 * consumers.md）。教学版把它压成**一个键**：世界的两张面生来同一个对象，
 * 「成对挂载、共享身份」不再靠装配纪律保证，靠类型保证。取舍：真仓的
 * 两键形态让 fs 与 subprocess 可以独立演化（fs-sandbox 与 bash-sandbox 是
 * 分别换的 provider）；教学版不做独立替换，一个键让「一键换世界」肉眼可见。
 *
 * seam 三角色（沿用 s09 的表格口径）：
 *
 * | 角色 | 本课文件 | dsh 对应（execution world） |
 * |---|---|---|
 * | Service Definition | 本文件：`ExecutionWorld` + `world` 键 | packages/fs/fs + packages/subprocess/subprocess（两 seam 一世界） |
 * | Service Provider | world-local.ts、world-sandbox.ts | fs-local + subprocess-local（本机）；fs-e2b + subprocess-e2b（远端沙箱） |
 * | Consumer | world-tools.ts 的 run_command + s09 的 fsTools | tool-bash（经 shell seam → subprocess）、tool-fs（经 fs seam） |
 */

/**
 * 一次 spawn 的执行事实。退出码是**结果**不是错误：命令跑了、以 N 退出，
 * 模型看 stdout/stderr 决定下一步。策略拒绝（{@link WorldError}）才是错误
 * ——命令根本没跑，模型该换命令而不是重试。两类信息模型的正确反应不同，
 * 所以契约把它们分在两个通道里。dsh 对应 SubprocessOutcome / CollectedOutput
 * （packages/subprocess/subprocess/src/types.ts）：exit facts 随 handle 的
 * done resolve，spawn 级失败才 reject。
 */
export interface SpawnResult {
  /** 进程退出码：0 成功；非零表示命令跑了但失败；127 表示可执行文件不存在。 */
  exitCode: number
  /** 子进程 stdout 的全部文本。 */
  stdout: string
  /** 子进程 stderr 的全部文本。 */
  stderr: string
}

/**
 * 执行世界层面的策略失败分类——契约的一部分（沿 s09 的立场：错误语义
 * 落在 Definition，两边共用同一批码，Consumer 据码补补救语，不解析文本）。
 * dsh 的同位词汇散在两个 seam 里：fs-sandbox 抛 `FS_SANDBOX_DENIED`
 * （packages/fs/fs/src/types.ts），bash-sandbox 抛 `SANDBOX_UNAVAILABLE`
 * （packages/sandbox/sandbox）；教学版把「世界拒绝」归成两码。
 */
export type WorldErrorCode =
  /**
   * 命令不在本世界的命令白名单里——LocalWorld 的部署策略：真机器什么都能
   * 跑，所以「哪些能跑」必须显式列出来；检查在 fork **之前**（拒绝时进程
   * 根本没有启动）。模型可改用白名单内的命令重试。
   */
  | 'WORLD_COMMAND_DENIED'
  /**
   * 命令要操作的路径在本世界的路径围栏之外——SandboxWorld 的部署策略：
   * 进程内虚拟世界只认 `/sandbox/` 前缀。与「文件不存在」严格分开（后者
   * 是执行结果，走 stderr + 非零退出码）；模型可改用围栏内的路径重试。
   */
  | 'WORLD_PATH_DENIED'

/**
 * 类型化的执行世界错误：message 面向人（原样进入模型可见的回喂文本），
 * code 面向程序。语义与 s09 的 FsError 相同，管理的是 spawn 面的策略失败。
 */
export class WorldError extends Error {
  /** 稳定失败码：见 {@link WorldErrorCode}。 */
  readonly code: WorldErrorCode

  constructor(message: string, code: WorldErrorCode) {
    super(message)
    this.name = 'WorldError'
    this.code = code
  }
}

/**
 * 统一执行世界的服务契约。
 *
 * **fs 面**：直接 `extends FsService`——s09 的三操作契约（错误分类、原子
 * 替换、目录不读内容）一个字不差地成为世界的一部分。这是「复用/委托」
 * 取舍里最省的一种：不重声明、不包装，世界的 fs 面在类型上**就是** s09
 * 的契约，s09 的契约测试原样继续跑。dsh 的 fs-e2b 同款做法：实现
 * `FileSystem` 抽象类，fs 契约没有「E2B 版」。
 *
 * **spawn 面**：`spawn(command, args)` 跑一条 argv（不经 shell 解释——
 * command 是 argv[0]，args 是 argv[1..]，dsh 的 subprocess 契约把 shell
 * 语义明确划给 Consumer："Command defaulting, shell semantics, deadlines,
 * protocol framing … belong to consumers"，packages/subprocess/subprocess/
 * src/index.ts）。语义约定：
 *
 * - 返回 {@link SpawnResult}：**收集** stdout/stderr 到完成（教学版只有
 *   collect 模式；dsh 另有 raw 管道与终端两种 stdio 形态，本课不收）。
 * - 非零退出码照常 resolve——它是命令的输出事实，不是世界层的失败。
 * - 可执行文件不存在：resolve 为 `exitCode: 127` + stderr 说明（真 shell
 *   的同款退出码）。「白名单里有、机器上没有」是部署事实，回喂让模型换
 *   命令；与策略拒绝（抛 {@link WorldError}）区分开。
 * - **spawn 前策略检查**：白名单（LocalWorld）/ 路径围栏（SandboxWorld）
 *   在任何副作用发生之前执行，拒绝抛 {@link WorldError}、零副作用。为什么
 *   在事前而不是事后审计：事后拦下的命令**已经跑过**——副作用收不回，
 *   模型「换命令重试」救不回泄漏；dsh 的同款立场是 bash-sandbox 在 spawn
 *   前用 `ctx.sandbox.confine()` 包好 argv，"Positive runner-launch evidence
 *   means the command never ran"（packages/shell/bash-sandbox/src/index.ts）。
 *
 * @param command - 可执行文件名或绝对路径（argv[0]）。
 * @param args - 命令参数（argv[1..]），原样传递。
 * @returns 退出码与收集到的输出。
 * @throws WorldError WORLD_COMMAND_DENIED / WORLD_PATH_DENIED（策略拒绝，
 *   进程未启动、世界零副作用）。
 */
export interface ExecutionWorld extends FsService {
  spawn(command: string, args: readonly string[]): Promise<SpawnResult>
}

// 服务目录扩展：给迷你 ServiceMap 加 'world' 键。键与类型归 Definition 所有
// （与 s09 的 'fs' 键同款）；world-plugin.ts 贡献实例，Consumer 按键消费。
declare module './cordis.js' {
  interface ServiceMap {
    /** 统一执行世界：fs + subprocess 两面，由装配选择的 provider 贡献。 */
    world: ExecutionWorld
  }
}
