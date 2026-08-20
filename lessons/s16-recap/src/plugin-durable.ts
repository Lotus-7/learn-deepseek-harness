import type { Plugin } from './cordis'
import type { LoggedEvent } from './log'
import type { SessionFile } from './persistence'

// persistence 插件的服务目录扩展（s16）：种子历史经服务流向后挂的行。
declare module './cordis.js' {
  interface ServiceMap {
    /** 持久化服务：本会话从盘上带回的种子事件（persistence 插件贡献）。 */
    persistence: PersistenceService
  }
}

/**
 * `persistence` 服务：resume 场景下「历史从哪来」的装配期答案。
 * 只有种子事件一件事——落盘的另一半（新事件怎么写回去）在 durable
 * 插件的监听器里，不暴露成服务（写路径只有一个：经 sessions 落账）。
 */
export interface PersistenceService {
  /** resume 从文件读回的前缀事件（新会话为空数组——「没有历史」也是明确答案）。 */
  readonly seed: readonly LoggedEvent[]
}


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

/**
 * persistence 插件（s16 把它接进 BASE 行）：持久能力的**装配期半边**。
 * 与 {@link durablePlugin} 的分工——同一能力的两半时刻：
 *
 * - durable 是**运行时半边**：监听落账广播，把每条新事件写回文件；
 * - persistence 是**装配期半边**：贡献 `persistence` 服务携带种子事件
 *   （resume 从文件读回的前缀），让**后挂载的行**能取到「历史从哪来」，
 *   并把 durable 挂成自己的子插件（级联卸载）。
 *
 * 为什么种子走服务而不是 assemble 的局部变量：行序即挂载序（s14 的约定），
 * persistence 行在 tools 行之前挂载、其服务即刻在场，tools 行构造时用
 * `ctx.has('persistence')` 显式分支（有则续会话、无则新会话）——依赖经
 * 服务目录流动，「装配器是一个普通插件序列」的结构保持不变。对照 dsh：
 * seed 不走插件挂载序，走 SessionStore.prepare(id, { seed }) 的构造期参数
 * （"Initial replay or fork history supplied at construction"，
 * packages/core/session/src/types.ts）——真码行序无加载语义，教学版行序
 * 即挂载序，这个差异 s14 已经立过。
 * @param file - 已打开追加句柄的会话文件（新会话是 materialize 的产物，
 *   resume 是修盘后的 openAppend 产物——由 assemble 在构造本插件前决定）。
 * @param seed - 种子事件：resume 的前缀（含修盘后的合成收尾），新会话为空数组。
 * @returns 可挂载的插件（名字 'persistence'；durable 是它的子插件）。
 */
export function persistencePlugin(file: SessionFile, seed: readonly LoggedEvent[]): Plugin {
  return {
    name: 'persistence',
    apply(ctx) {
      ctx.service('persistence', { seed })
      ctx.mount(durablePlugin(file))
    },
  }
}
