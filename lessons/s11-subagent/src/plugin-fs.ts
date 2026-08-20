import type { Plugin } from './cordis'
import type { FsService } from './fs-service'

/**
 * fs provider 插件：把装配选定的 provider 实例贡献为 ctx 的 `fs` 服务。
 *
 * 「选谁」发生在装配处（index.ts / 测试的组装函数）——显式传入哪个
 * `createXxxFs()` 的产物，这一步就是部署决策本身；本插件不含任何
 * `?? 默认 provider`（隐藏默认 = 把部署决策偷进机制，misconfiguration
 * 就不再 fails loud）。dsh 对应：provider 作为插件加载即注册服务——
 * ShellExecutor 的 JSDoc 写明「one implementation per context; loading a
 * second throws, which is cordis' standard duplicate-service behavior」，
 * fs 同理（fs-local 与 fs-sandbox 二选一挂载）。
 *
 * 挂上后这条服务遵循 s08 的一切机制：注册即效果（卸载即注销——能力随
 * provider 消失）、重名贡献当场抛错（重复装配响亮失败）。
 * @param fs - 装配选定的 provider 实例（任一 FsService 实现）。
 * @returns 可挂载的插件。
 */
export function fsPlugin(fs: FsService): Plugin {
  return {
    name: 'fs-provider',
    apply(ctx) {
      ctx.service('fs', fs)
    },
  }
}
