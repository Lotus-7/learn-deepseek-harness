import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { FsError, type FsEntry } from './fs-service'
import { WorldError, type ExecutionWorld, type SpawnResult } from './world-service'

const execFileAsync = promisify(execFile)

/**
 * LocalWorld：本机执行世界——真磁盘 + 真 child_process，统一执行世界的第一个 Provider。
 *
 * 两张面的部署事实：
 *
 * - **fs 面是真磁盘**：路径是宿主 OS 的绝对路径，围栏是 `root`（构造时给定
 *   的绝对目录）——本世界的工作目录。dsh 对应 packages/fs/fs-local 的
 *   LocalFileSystem：`cwd` 是相对路径的解析基点（"a resolution default, NOT
 *   a containment boundary"）；教学版直接把可达根设成 root，让 Local 与
 *   Sandbox 的越界语义对称（都抛 FS_OUT_OF_ROOT），同一契约断言集能跑两遍。
 * - **spawn 面是真进程**：`node:child_process` 的 execFile 跑 argv、收集
 *   stdout/stderr 到完成。dsh 对应 packages/subprocess/subprocess-local 的
 *   LocalSubprocessRuntime（detached 进程树、SIGTERM→grace→SIGKILL 升级、
 *   凭据清洗的环境）；教学版只收 collect 语义，注释里标注差距。
 *
 * **白名单是本世界的策略**：真机器什么命令都能跑，所以「哪些能跑」必须是
 * 显式配置（构造参数必传，没有隐藏默认——沿 s09 的「显式组装」红线）。
 * 检查在 fork **之前**：拒绝抛 WORLD_COMMAND_DENIED、进程根本不启动；
 * 白名单里的命令在机器上不存在时按部署事实回 127 + stderr，不混同于策略拒绝。
 *
 * @param options - 部署参数：工作目录根与命令白名单。
 * @returns 实现完整 ExecutionWorld 契约的服务实例。
 */
export interface LocalWorldOptions {
  /** 可达根：绝对目录路径，fs 面只放行它之内的路径。 */
  root: string
  /**
   * 命令白名单：允许作为 argv[0] 的可执行名或绝对路径。必须显式传入——
   * 「哪些命令能跑」是部署决策，不设默认（dsh 同款立场：No hardcoded
   * tunables；白名单在真仓的对应物是 sandbox 策略层，不是执行器默认）。
   */
  allowedCommands: readonly string[]
}

/** 围栏：root 之内（等于 root，或以 `root/` 开头）放行；越界在动磁盘之前抛错。 */
function assertInRoot(path: string, root: string): void {
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new FsError(`路径 "${path}" 在本世界的根 ${root} 之外（FS_OUT_OF_ROOT）`, 'FS_OUT_OF_ROOT')
  }
}

/** 把宿主 fs 的错误码翻译成契约的 FsError（不把系统错误文本漏给模型面）。 */
function asFsError(error: unknown, path: string): Error {
  const code = (error as { code?: unknown }).code
  if (code === 'ENOENT') return new FsError(`"${path}" 不存在（FS_NOT_FOUND）`, 'FS_NOT_FOUND')
  if (code === 'EISDIR') return new FsError(`"${path}" 是目录，不是普通文件（FS_NOT_A_FILE）`, 'FS_NOT_A_FILE')
  if (code === 'ENOTDIR') return new FsError(`"${path}" 是文件，不是目录（FS_NOT_A_DIRECTORY）`, 'FS_NOT_A_DIRECTORY')
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 创建本机执行世界。
 * @param options - 见 {@link LocalWorldOptions}。
 * @returns ExecutionWorld 实例：fs 面落真磁盘、spawn 面真 fork，策略检查都在副作用之前。
 */
export function createLocalWorld(options: LocalWorldOptions): ExecutionWorld {
  const { root, allowedCommands } = options
  const allowlist = new Set(allowedCommands)

  return {
    async readFile(path) {
      assertInRoot(path, root)
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        throw asFsError(error, path)
      }
    },

    async writeFile(path, content) {
      assertInRoot(path, root)
      try {
        // 父目录连同创建（契约：writeFile 不要求目录先存在）；node 的 writeFile
        // 整体替换——与 MemoryFs 的 Map.set 同一「原子替换」语义。
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content, 'utf8')
      } catch (error) {
        throw asFsError(error, path)
      }
    },

    async listDir(path): Promise<FsEntry[]> {
      assertInRoot(path, root)
      // stat 先行定语义（不存在 / 是文件），readdir 只对确认过的目录调用。
      // stat 与 readdir 之间的竞态窗口（目标被并发换掉）教学版不处理——
      // 真 fs-sandbox 用 re-canonicalize 缩窄同类 TOCTOU（fs-sandbox/src 的
      // checkedTarget 注释），本课 README「看真码」细讲。
      const info = await stat(path).catch((error: unknown) => {
        throw asFsError(error, path)
      })
      if (info.isFile()) {
        throw new FsError(`"${path}" 是文件，不是可列的目录（FS_NOT_A_DIRECTORY）`, 'FS_NOT_A_DIRECTORY')
      }
      const entries = await readdir(path, { withFileTypes: true })
      // 按名字稳定排序：与 MemoryFs/RemoteFs 同一承诺（同一状态同一顺序）。
      return entries
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },

    async spawn(command, args): Promise<SpawnResult> {
      // 策略检查在 fork 之前：白名单外的命令在这里拒绝，进程根本不启动
      // （拒绝零副作用——「先跑再拦」收不回已经发生的执行）。
      if (!allowlist.has(command)) {
        throw new WorldError(
          `命令 "${command}" 不在本世界的白名单内（可用：${[...allowlist].join('、')}）（WORLD_COMMAND_DENIED）`,
          'WORLD_COMMAND_DENIED',
        )
      }
      try {
        const done = await execFileAsync(command, [...args], { encoding: 'utf8' })
        return { exitCode: 0, stdout: done.stdout, stderr: done.stderr }
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean }
        // 可执行不存在：shell 世界约定的 127。它与「命令在白名单里」并不矛盾
        // ——白名单是策略（本世界许不许跑），127 是事实（这台机器有没有）。
        if (failure.code === 'ENOENT') {
          return { exitCode: 127, stdout: '', stderr: `"${command}": 本机 PATH 上没有这个可执行文件（127）` }
        }
        if (typeof failure.code === 'number') {
          return { exitCode: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
        }
        throw error instanceof Error ? error : new Error(String(error))
      }
    },
  }
}
