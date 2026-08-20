import type { Plugin } from './cordis'
import type { ExecutionWorld } from './world-service'

/**
 * execution-world provider 插件：把装配选定的世界贡献为**两个**服务键。
 *
 * - `world`：本课的新键——run_command 等需要 spawn 面的 Consumer 按键消费；
 * - `fs`：s09 的键——read_file / write_file / list_dir 三个 Consumer 零改动
 *   继续工作（ExecutionWorld extends FsService，世界的 fs 面在类型上就是
 *   s09 的契约，同一个对象两个键都放得上）。
 *
 * 一个对象、两个键，是 dsh「两个 seam 共享一个执行世界」的教学投影：真仓
 * 里 fs 与 subprocess 是两个服务键、由决策笔记约定成对挂载（"Providers
 * mounted together must describe the same path namespace, executables,
 * processes, and terminal sessions"）；教学版把「成对」折进一个插件——挂上
 * 即成对，重复挂载在**第一个键**上就被重名检查拦下（两个键都注册，第二个
 * 插件的 `fs` 贡献当场抛错），不会出现「fs 是沙箱、进程是本机」的错位世界。
 *
 * 「选谁」仍然发生在装配处（index.ts 的 `worldPlugin(...)` 行）——本插件
 * 与 s09 的 fsPlugin 一样不含任何 `?? 默认世界`。
 * @param world - 装配选定的世界实例（任一 ExecutionWorld 实现）。
 * @returns 可挂载的插件。
 */
export function worldPlugin(world: ExecutionWorld): Plugin {
  return {
    name: 'world-provider',
    apply(ctx) {
      ctx.service('fs', world)
      ctx.service('world', world)
    },
  }
}
