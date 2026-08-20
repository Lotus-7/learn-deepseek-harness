import type { ChatMessage } from '@learn-dsh/mock-model'
import { Ctx } from './cordis'
import type { SessionLog } from './log'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin, type SessionService } from './plugin-tools-session'
import { loopPlugin } from './plugin-loop'
import {
  SubagentError,
  type SubagentProvider,
  type SubagentRun,
  type SubagentOutcome,
  type SubagentSpawnRequest,
} from './subagent-service'

/**
 * in-process spawn provider：在**同一进程**里为每次委派组装一个子代理——
 * 子代理的私有 runLoop（复用 loop 插件）+ 私有事件日志（自己的 sessions 服务）
 * + 受限工具名册（请求显式携带的白名单）。
 *
 * dsh 对应 packages/subagent/subagent-spawn-in-process（provider 注册）+
 * packages/subagent/subagent-in-process-driver（共享驱动：深度检查、一次性执行、
 * 结果折叠、quiescent disposal）。真码的子是同 Context 上的 fresh child Agent
 * （"its own session, own system prompt, zero parent context"）；教学版的子是
 * **子 ctx 上的三件套装配**——model（继承父的模型实例）、tools-session（受限
 * 名册 + 私有日志）、loop。permission / compaction 不在子的默认装配里：受限
 * 工具集本身就是子的能力围栏（调不到的工具响亮报错），而压缩是父装配的可选项
 * ——dsh 里子代理 join 父的 preset 组合（applyChildComposition），教学版把这个
 * 「继承组合」收窄成「继承模型 + 白名单工具」两件。
 *
 * **工具实现是同一批对象**：toolset 里的 Tool 是委托方名册里的那些（工具体闭包
 * 绑定父装配容器），子代理执行它们时照常经父容器解析服务（fs 工具落到父的执行
 * 世界——父写的文件子读得到，执行世界是部署级共享的，s10 的立场在委派下不变）。
 * 受限的只是**名册**：dsh 同款（toolFilter 过滤可见性，不复制实现）。
 */

/**
 * 从子的派生历史选最终回答：最后一条**非空** assistant 消息。
 * dsh 对应 finalAssistantOutput（packages/subagent/subagent/src/assistant-output.ts）：
 * 空内容消息（含纯 usage 消息）跳过，一条都没有时回退到累积的 assistant 文本流，
 * 教学版没有流式，回退为空串。
 * @param messages - 子循环结束时日志投影出的派生历史。
 * @returns 最终回答文本；子没有产出非空 assistant 消息时为空串。
 */
function finalAnswer(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role === 'assistant' && message.content !== null && message.content !== '') {
      return message.content
    }
  }
  return ''
}

/**
 * 从子的私有日志折叠结构化结果。**只从日志读**（事件是唯一权威）：stopReason 取
 * 最后一个 turn/end 的 reason，没有 turn/end（保险丝熔断留下未闭合的 turn）按
 * 'error' 对待——不夸大成功。
 * @param log - 子代理的私有日志（循环已收口或已熔断）。
 * @returns 父侧拿到的结构化结果。
 */
function outcomeOf(log: SessionLog): SubagentOutcome {
  let stopReason: SubagentOutcome['stopReason'] = 'error'
  let turns = 0
  const used: string[] = []
  for (const event of log.events) {
    if (event.type === 'turn/start') turns += 1
    if (event.type === 'turn/end') stopReason = event.reason
    if (event.type === 'tool/call' && !used.includes(event.name)) used.push(event.name)
  }
  return {
    answer: finalAnswer(log.deriveMessages()),
    stopReason,
    toolsUsed: used,
    eventCount: log.events.length,
    turns,
  }
}

/**
 * 组装 in-process spawn provider。
 * @param ctx - 委托方（父）的装配容器：spawn 时经它解析 `model` 服务——子代理
 *   继承父的模型（dsh：resolveChildAgentOptions 继承 parent 的 provider/model
 *   route，packages/subagent/subagent/src/child-agent.ts）。
 * @returns 名为 'spawn' 的 provider（交给 subagentPlugin 注册）。
 */
export function createInProcessSubagentProvider(ctx: Ctx): SubagentProvider {
  return {
    name: 'spawn',
    spawn(request: SubagentSpawnRequest): SubagentRun {
      // 深度检查在子代理启动之前：拒绝时没有子装配、没有子日志、零副作用。
      // dsh 对应 resolveChildDepth（child-agent.ts）抛 SubagentDepthError——
      // "a start rejects before child ownership begins"。
      const childDepth = (request.depth ?? 0) + 1
      if (request.maxDepth !== undefined && childDepth > request.maxDepth) {
        throw new SubagentError(
          `子代理委派深度 ${childDepth} 超过上限 ${String(request.maxDepth)}（SUBAGENT_DEPTH_EXCEEDED）`,
          'SUBAGENT_DEPTH_EXCEEDED',
        )
      }

      // —— 子装配：三件套挂进子 ctx，与父的装配互不可见 ——
      // 三件套包在一个占位插件里：插件内 mount 的子插件，其卸载挂进父作用域
      // （cordis.ts 的级联规则）——dispose 一个 unmount 即逆序回滚全部子装配。
      const childCtx = new Ctx()
      const model = ctx.get('model') // 运行时解析：委派发生时父的模型必已在场
      const unmount = childCtx.mount({
        name: 'subagent-child',
        apply(target) {
          target.mount(modelPlugin(model)) // 继承父模型：子与父用同一个适配器实例
          target.mount(toolsSessionPlugin([...request.toolset])) // 受限名册 + 私有日志
          target.mount(loopPlugin()) // 私有 runLoop：复用 s08 以来的 loop 插件
        },
      })
      const sessions: SessionService = childCtx.get('sessions')

      // —— 驱动：一次性执行，结果从子日志折叠 ——
      // result 只 resolve 不 reject：子的循环抛错（剧本耗尽、模型层失败）在这里
      // 落成 stopReason 'error' 的 outcome，回喂与否由 Consumer 决定（dsh 同款：
      // child-level failure resolves，不 reject）。
      const result = (async (): Promise<SubagentOutcome> => {
        try {
          await childCtx.get('agent').run(request.task, { signal: request.signal })
        } catch {
          // 循环上抛的模型层错误已经收口为子日志里的 turn/end(error)；从这里起
          // 结果一律从日志折叠，异常不再穿透 seam。
        }
        return outcomeOf(sessions.log)
      })()

      return {
        result,
        log: sessions.log,
        dispose: unmount,
      }
    },
  }
}
