import type { Plugin } from './cordis'
import { maybeCompact, type CompactionOptions } from './compaction'
import type { SessionService } from './plugin-tools-session'

/**
 * compaction 插件（五件套之四）：把 s06 的压缩器挂到 loop 的步骤边界上。
 * 挂法与 dsh 逐字对应：BasicCompactionEngine 用 `ctx.on('agent/pre-step', …)`
 * 监听 loop 发起的步骤前瀑布，压缩完 `return next()` 委托——步骤照常进行
 * （packages/compaction/compaction-basic/src/index.ts）。压缩从此不归循环管：
 * runLoop 不再有 `compaction` 参数，loop 插件只发起 agent/pre-step 瀑布，
 * 谁挂、挂几个、用什么策略，loop 一无所知——卸载本插件，行为回到 s05
 * （无压缩），测试钉住这一点。
 * 阈值、尾部窗口、摘要器经工厂参数（插件配置）传入：换一个摘要器就是
 * 换一个 compaction 插件实例，压缩器代码零改动（演示第三幕）。
 */
export function compactionPlugin(options: CompactionOptions): Plugin {
  return {
    name: 'compaction',
    apply(ctx) {
      ctx.on('agent/pre-step', async (probe, next) => {
        // 服务在运行时读取（注册时 tools-session 可能还没挂）；
        // 瀑布被发起时装配必然已完成——get 不到就响亮报错（misconfiguration fails loud）。
        const sessions: SessionService = ctx.get('sessions')
        // 落账走 session 服务的 append：压缩事件与其它事实一样「落账即广播」。
        await maybeCompact(sessions.log, options, sessions.append)
        // 压缩完委托：步骤照常进行。教学版短路只跳过链上后续监听器——loop
        // 丢弃瀑布返回值、请求照发，这里没有「拒绝下一步」的语义；dsh 的
        // pre-step 决议（PreStepDecision）才可 reject 步骤且被 loop 尊重
        // （见 plugin-loop.ts 的事件目录注释）。
        return next(probe)
      })
    },
  }
}
