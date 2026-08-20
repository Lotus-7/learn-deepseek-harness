import { createRemoteFs } from './fs-remote'
import { FsError, type FsService } from './fs-service'
import { WorldError, type ExecutionWorld, type SpawnResult } from './world-service'

/**
 * SandboxWorld：进程内虚拟执行世界——虚拟 FS + 模拟执行，第二个 Provider。
 *
 * 与 LocalWorld 的部署差异（这就是「换个世界」要展示的东西）：
 *
 * - **零真进程**：spawn 面是一个虚拟命令解释器——它识别一小组命令
 *  （echo / cat / wc），在虚拟 FS 上操作，永远不 fork。真实远端沙箱的
 *  对应物是 e2b 家族：执行发生在另一台 Linux 机器里，宿主只看见 API
 *  （packages/e2b/subprocess-e2b——「Sandbox.commands.run」驱动远端进程组）。
 * - **路径围栏是本世界的策略**：只认 `root`（默认 `/sandbox`）之内的路径。
 *  虚拟世界没有 `/etc`、没有家目录——越界不是「权限不够」，是「这个坐标
 *  在本世界里不存在」。围栏拒绝抛 WORLD_PATH_DENIED、发生在解释命令之前，
 *  虚拟 FS 零副作用。
 *
 * **fs 面直接复用 s09 的 RemoteFs**：`createRemoteFs({ root: '/sandbox' })`
 * 本来就是「前缀围栏 + 进程内 Map 存储」——SandboxWorld 把它整个拿来当
 * 虚拟 FS，自己只加虚拟命令解释器。这是 s09「组合」路线的兑现：围栏代码
 * 不重写（s09 的契约测试原样盖住它），等待函数传同步落定——虚拟世界没有
 * 网络往返可模拟。dsh 的同构：fs-e2b 也是「实现既有契约 + 带来新部署
 * 事实」，fs 工具零改动。
 *
 * @param options - 部署参数：虚拟世界的可达根。
 * @returns 实现完整 ExecutionWorld 契约的服务实例。
 */
export interface SandboxWorldOptions {
  /** 可达根前缀，默认 `/sandbox`。fs 与 spawn 两面共用这一条围栏。 */
  root?: string
}

/**
 * 创建进程内虚拟执行世界。
 * @param options - 见 {@link SandboxWorldOptions}。
 * @returns ExecutionWorld 实例：fs 面委托复用的围栏 FS，spawn 面是虚拟解释器。
 */
export function createSandboxWorld(options: SandboxWorldOptions = {}): ExecutionWorld {
  const root = options.root ?? '/sandbox'
  // 复用 s09 的 RemoteFs 当虚拟 FS：root 之外 FS_OUT_OF_ROOT（fs 面围栏）；
  // 等待函数同步落定——虚拟世界的部署特征是「零真开销」，不模拟网络延迟。
  const fs: FsService = createRemoteFs({ root, wait: () => Promise.resolve() })

  /**
   * spawn 面的路径围栏：**碰文件系统的命令**（cat / wc）的路径参数必须在
   * root 之内。echo 不碰 FS——它的「路径样」参数只是文本，围栏不管它
   * （围栏拦的是操作，不是字符）。在解释命令之前执行：拒绝时虚拟 FS
   * 一个字节都没动。
   */
  const fencePaths = (command: string, args: readonly string[]): void => {
    if (command !== 'cat' && command !== 'wc') return
    for (const arg of args) {
      if (!arg.startsWith('/')) continue // 选项（-l）与普通文本不适用围栏
      if (arg !== root && !arg.startsWith(`${root}/`)) {
        throw new WorldError(
          `命令 ${command} 要操作的路径 "${arg}" 在本沙箱的围栏 ${root} 之外（WORLD_PATH_DENIED）`,
          'WORLD_PATH_DENIED',
        )
      }
    }
  }

  /** 虚拟 cat/wc 读不到目标的仿真输出：退出码 1 + stderr（真 cat/wc 同款）。 */
  const notReadable = (command: string, path: string, error: unknown): SpawnResult => ({
    exitCode: 1,
    stdout: '',
    stderr: `${command}: ${path}: ${error instanceof FsError && error.code === 'FS_NOT_A_FILE' ? '是一个目录' : '没有这个文件'}`,
  })

  return {
    // fs 面：整面委托给复用的围栏 FS（spread 即委托——工厂返回的是无 this
    // 的闭包对象，方法自包含）。s09 的 fs 契约与测试原封不动地盖住这一面。
    ...fs,

    async spawn(command, args): Promise<SpawnResult> {
      // 路径围栏在解释命令之前：越界拒绝零副作用（测试钉住）。
      fencePaths(command, args)
      switch (command) {
        // echo：把参数原样输出（真实 echo 语义：空格连接 + 结尾换行）。
        case 'echo':
          return { exitCode: 0, stdout: `${args.join(' ')}\n`, stderr: '' }
        // cat：读虚拟 FS。文件不存在不是围栏拒绝——是执行结果（退出码 1），
        // 仿真真 cat 的行为：模型看到 stderr 能判断「路径写错了」。
        case 'cat': {
          if (args.length !== 1) {
            return { exitCode: 2, stdout: '', stderr: `虚拟 cat 只接受恰好一个文件参数（收到 ${args.length} 个）` }
          }
          try {
            return { exitCode: 0, stdout: await fs.readFile(args[0]!), stderr: '' }
          } catch (error) {
            return notReadable('cat', args[0]!, error)
          }
        }
        // wc -l <file>：数换行符个数（POSIX wc 语义：结尾无换行的最后一行不计）。
        case 'wc': {
          if (args.length !== 2 || args[0] !== '-l') {
            return { exitCode: 2, stdout: '', stderr: `虚拟 wc 只支持 -l <文件> 形态（收到：${args.join(' ')}）` }
          }
          try {
            const content = await fs.readFile(args[1]!)
            const lines = content.split('\n').length - 1
            return { exitCode: 0, stdout: `${lines} ${args[1]}\n`, stderr: '' }
          } catch (error) {
            return notReadable('wc', args[1]!, error)
          }
        }
        // 未知命令：本虚拟世界没有实现它——与真机器的「命令不存在」同语义
        // （127），不是策略拒绝。给虚拟世界加命令是合法演进：加一个 case
        // 即可（README「改两个地方」的第二处演示这一点）。
        default:
          return {
            exitCode: 127,
            stdout: '',
            stderr: `本虚拟世界没有实现命令 "${command}"（已实现：echo、cat、wc）`,
          }
      }
    },
  }
}
