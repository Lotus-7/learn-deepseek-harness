import type { Plugin } from './cordis'
import type { SessionFile } from './persistence'

/**
 * durable 插件（五件套之外的第六件）：把每条落账事件**同步**写进会话文件。
 *
 * 挂法对照 dsh 的 PersistenceCoordinator.installWritePath
 * （packages/session/session-persistence/src/coordinator.ts）：它也是
 * `ctx.on('session/event', …)` 监听落账广播驱动写盘——写盘不是「改写会话
 * 事实」，是把事实搬到盘上，观察型广播恰好是它的天然挂点（s12 的 job
 * 推进器是同一先例）。差别在**时机**：
 *
 * - 教学版：监听器**同步** fsync——`sessions.append()` 返回时事件已在盘上，
 *   「模型看得见 ⟺ 已落账 ⟺ 已落盘」三件事同时成立。断言也因此可以写成
 *   「跑完一个 turn，立刻读文件，逐事件与内存日志相等」。
 * - 真码：活会话走有界批缓冲（SessionWriteBehind，窗口默认 200ms——
 *   `DEFAULT_WRITE_BATCH_MAX_DELAY_MS`），`session/flush` 才是即时屏障；
 *   checkpoint-policy 插件再在「下一个模型请求前 / 顶层工具副作用前 /
 *   pre-step 边界」主动要屏障。生产版不能每事件 fsync：流式对话每秒
 *   落几十个 chunk，逐条 fsync 的吞吐撑不住；有界窗口把「至多丢 200ms
 *   的事件」换成了三倍以上的写吞吐，再把丢不起的位置（副作用前、请求前）
 *   显式围起来。教学版没有吞吐压力，选最强的时机语义换确定性。
 *
 * 卸载即关句柄（注册即效果）：effect 的清理函数负责 close，插件卸载后
 * 不会再有事件写进这个文件。
 * @param file - 已打开追加句柄的会话文件（materialize 或 openAppend 的产物）。
 * @returns 可挂载的插件。
 */
export function durablePlugin(file: SessionFile): Plugin {
  return {
    name: 'durable',
    apply(ctx) {
      ctx.on('session/event', ({ event }) => file.append(event))
      ctx.effect(() => () => file.close())
    },
  }
}
