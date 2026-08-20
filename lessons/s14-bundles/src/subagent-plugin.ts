import type { Plugin } from './cordis'
import {
  assertMaxDepth,
  type SubagentHandle,
  type SubagentProvider,
  type SubagentService,
  type SubagentSpawnRequest,
} from './subagent-service'

/**
 * subagent 服务插件：把装配选定的 provider 贡献为 `subagents` 服务。
 *
 * 服务面只做三件事：编号（会话内单调递增的 sub-N，logOf 据此回答）、域校验
 * （maxDepth 必须是非负安全整数——校验归 seam 而不是只靠模型面入口）、把
 * provider 的 run 连同编号登记进本会话的子代理名册。**spawn 的全部实质
 * （深度比较、子装配、驱动）都在 provider 里**——服务是薄壳，这正是 seam 的
 * 分工：换一个 provider（比如 fork 式、或未来的跨进程传输），服务面零改动。
 *
 * dsh 对应 SubagentRuntime（packages/subagent/subagent/src/index.ts）——那里服务
 * 还持有 named-provider 注册表（registerProvider/getProvider/list）、能力校验
 * （assertCapabilities：请求要的能力 provider 不支持就 UNSUPPORTED_CAPABILITY）
 * 与 continuable 子代理的管理器。教学版单 provider：注册表退化为本插件的工厂
 * 参数，「选谁」发生在装配处（与 s09 的 fsPlugin、s10 的 worldPlugin 同款：
 * 不含任何 `?? 默认 provider`）。
 *
 * @param provider - 装配选定的 provider（本课用 createInProcessSubagentProvider）。
 * @returns 可挂载的插件。
 */
export function subagentPlugin(provider: SubagentProvider): Plugin {
  return {
    name: 'subagent',
    apply(ctx) {
      /** 本会话已启动的子代理：编号 → 句柄（logOf 的数据面）。 */
      const runs = new Map<string, SubagentHandle>()
      let nextId = 1

      const service: SubagentService = {
        spawn(request: SubagentSpawnRequest): SubagentHandle {
          if (request.maxDepth !== undefined) assertMaxDepth(request.maxDepth)
          const id = `sub-${nextId++}`
          // provider 的拒绝（深度超限）从这里原样上抛：调用方（delegate 工具）
          // 捕获后转成回喂文本——「响亮拒绝并回喂」的两段分工。
          const run = provider.spawn(request)
          const handle: SubagentHandle = { id, ...run }
          runs.set(id, handle)
          return handle
        },
        logOf(id: string) {
          const handle = runs.get(id)
          if (handle === undefined) {
            throw new Error(
              `没有编号为 "${id}" 的子代理（本会话：${[...runs.keys()].join(', ') || '无'}）`,
            )
          }
          return handle.log
        },
      }
      ctx.service('subagents', service)
    },
  }
}
