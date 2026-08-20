import { createMemoryFs } from './fs-memory'
import { FsError, type FsService } from './fs-service'

/**
 * RemoteFs：模拟的远端文件系统 provider——同一个契约的第二个实现。
 *
 * 与 MemoryFs 的两点**部署差异**（这就是「换个 provider，整个世界跟着走」
 * 要展示的东西——契约一个字不变，行为特征整体切换）：
 *
 * 1. **前缀隔离**：只放行 `root`（默认 `/remote`）之内的路径，越界在动手前
 *    抛 FS_OUT_OF_ROOT——模拟远端工作区的围栏。dsh 同位：
 *    packages/fs/fs-sandbox 的 SandboxedFileSystem 给 LocalFileSystem 的
 *    两个写操作加 per-call 围栏（`workspace-write` 只允许 canonicalize 后
 *    落在 workspace root 内的目标），拒绝抛 FS_SANDBOX_DENIED。
 * 2. **人为延迟**：每个到站操作等待 `latencyMs`（模拟网络往返），越界检查
 *    在等待**之前**——围栏是本地判断，不该为一个注定失败的请求付一次往返。
 *
 * 实现取舍：**组合一个 MemoryFs 当存储**，本 provider 只加「围栏 + 延迟」
 * 两件事——dsh 的 fs-sandbox 用继承做同一件事（extends LocalFileSystem，
 * 「all text-storage mechanics … are the local implementation's, verbatim;
 * this package adds only the per-call POLICY fence」）；教学版选组合，
 * 因为教学版的 Definition 是接口而非基类，没有可供继承的机制载体。
 * @param options - 部署参数：根前缀、往返延迟、等待函数（测试注入计数器）。
 * @returns 实现完整 FsService 契约的服务实例。
 */
export interface RemoteFsOptions {
  /** 可达根前缀，默认 `/remote`。根之外的路径一律 FS_OUT_OF_ROOT。 */
  root?: string
  /** 每个到站操作的模拟往返毫秒数，默认 40。 */
  latencyMs?: number
  /**
   * 等待函数：默认真实 setTimeout；测试注入同步计数器，把「每个操作
   * 等一次往返」变成可数的确定性断言（延迟本身不进断言——时钟不可靠）。
   */
  wait?: (ms: number) => Promise<void>
}

/** 缽数字工具：构造面向人的错误文本（code 已在括号里，回喂后模型可认）。 */
function outOfRoot(path: string, root: string): FsError {
  return new FsError(`路径 "${path}" 在本文件系统的根 ${root} 之外（FS_OUT_OF_ROOT）`, 'FS_OUT_OF_ROOT')
}

/**
 * 创建模拟远端文件系统。
 * @param options - 见 {@link RemoteFsOptions}。
 * @returns FsService 实例：围栏在延迟前，存储委托给内部 MemoryFs。
 */
export function createRemoteFs(options: RemoteFsOptions = {}): FsService {
  const root = options.root ?? '/remote'
  const latencyMs = options.latencyMs ?? 40
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const store = createMemoryFs()

  /** 围栏：根内（等于根，或以 `root/` 开头）放行；否则立即拒绝，零副作用。 */
  const fence = (path: string): void => {
    if (path !== root && !path.startsWith(`${root}/`)) throw outOfRoot(path, root)
  }

  return {
    async readFile(path) {
      fence(path)
      await wait(latencyMs)
      return store.readFile(path)
    },
    async writeFile(path, content) {
      fence(path)
      await wait(latencyMs)
      await store.writeFile(path, content)
    },
    async listDir(path) {
      fence(path)
      await wait(latencyMs)
      try {
        return await store.listDir(path)
      } catch (error) {
        // 可达根恒存在：模型探索本世界的第一站就是它——空根列出空表，
        // 而不是「不存在」（根之下没有文件不等于根不在）。仅此一处特判，
        // 其余目录语义与契约一字不差。
        if (path === root && error instanceof FsError && error.code === 'FS_NOT_FOUND') return []
        throw error
      }
    },
  }
}
