import type { ToolCall } from '@learn-dsh/mock-model'
import { Ctx, type AsyncWaterfallEvent, type EmitEvent, type Plugin, type ToolCallDecision } from './cordis'
import { SessionLog, type LoggedEvent, type SessionEvent } from './log'
import { ToolRegistry, registryOf } from './registry'
import { validateArguments, type ToolCallRecord } from './pipeline'
import type { Tool } from './tools'

// 本插件的事件与服务目录扩展。事件键用 dsh 的真名：
// - tools/pre-execute：工具执行前的异步拦截链（dsh 同名事件 @mode waterfall）。
//   s04 的 preExecute 数组与 s07 的同步 guard 拦截器在这里合流——裁决要等
//   审批（人）或别的异步决策，链必须是异步的。
// - session/event：每次落账后的广播（dsh 同名事件 @mode emit，SessionStore 的
//   post-commit feed）。tool/call、tool/result 的「ctx 事件留痕」经由它广播：
//   任何插件不 import 日志实现就能观察全部会话事实——第六插件的天然挂点。
declare module './cordis.js' {
  interface EventMap {
    /**
     * 一次工具调用穿过执行前的异步拦截链（可改写、可否决）。
     * 值是 {@link ToolCallDecision}：拦截器可改写 args、置 veto 否决（不调
     * next()，链短路，工具体不会执行），或 next() 放行。链尾（内置行为）是
     * 真正执行工具体——所有拦截器都委托时调用才到达执行。
     * 进入链的调用已过参数校验（与 s02 管线同序：校验在守卫前）。
     * dsh 对应 packages/core/tools/src/index.ts 的 'tools/pre-execute'
     * （@mode waterfall，exec 携带 signal）。
     * @mode waterfall-async
     */
    'tools/pre-execute': AsyncWaterfallEvent<ToolCallDecision>
    /**
     * 一条会话事实落账后的广播（观察，不能改写——日志 append-only）。
     * payload.event：刚落账的事件（深冻结，含 seq）。
     * dsh 对应 packages/core/session/src/index.ts 的 'session/event'
     * （post-commit、fire-and-forget）。
     * @mode emit
     */
    'session/event': EmitEvent<{ event: LoggedEvent }>
  }
  interface ServiceMap {
    /** 工具执行运行时：名册 + 经拦截链的执行（本插件贡献）。 */
    tools: ToolsService
    /** 会话服务：日志 + 落账即广播（本插件贡献）。 */
    sessions: SessionService
  }
}

/** 'tools' 服务：名册与执行。dsh 对应 ctx.tools（ToolRuntime，含执行管线）。 */
export interface ToolsService {
  /** 工具名册：组装模型请求用 schemas()，权限插件 lookup 取 schema。 */
  readonly registry: ToolRegistry
  /**
   * 经 ctx 拦截链执行一次工具调用并落账（tool/call 与 tool/result 一对）。
   * 顺序与 s02 管线相同：参数校验 → 拦截链（tools/pre-execute）→ 执行；
   * 五种失败（未知名、非法 JSON、校验不过、拦截否决、执行抛错）都不是
   * 进程崩溃，而是回喂模型的 tool/result。
   * @param call - 模型发起的一次 tool call（arguments 是原始 JSON 串）。
   * @param context.turn - 当前 turn 编号（落账用；由 loop 插件传入）。
   * @param context.signal - 本次 turn 的取消 signal；已触发时上抛（无 tool/result）。
   * @returns 这次调用的留痕；output 就是回喂模型的工具结果文本。
   * @throws signal 已触发（由 loop 收口为 turn/end(aborted)）。
   */
  execute(call: ToolCall, context: { turn: number; signal?: AbortSignal }): Promise<ToolCallRecord>
}

/** 'sessions' 服务：日志与广播。dsh 对应 ctx.sessions（SessionStore 的 Session.append feed）。 */
export interface SessionService {
  /** 本会话的 append-only 日志（模型可见历史由它投影）。 */
  readonly log: SessionLog
  /**
   * 落账一条事件并广播 'session/event'——落账与广播是同一动作，不漏不重。
   * 所有插件（loop、tools、未来的持久化/审计插件）都经它写事实；
   * 直接拿 log.append 绕过广播是装配错误（测试钉住：五件套跑完的每个事件都被广播）。
   * @param event - 调用方构造的事件（不含 seq）。
   * @returns 落盘后的冻结事件。
   */
  append(event: SessionEvent): LoggedEvent
}

/** 给违规报告用的值描述（s02 管线同款，复制自 pipeline.ts 的私有实现口径）。 */
function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array（${JSON.stringify(value)}）`
  return `${typeof value}（${JSON.stringify(value)}）`
}

/**
 * tools+session 插件（五件套之二）：一个插件贡献两个服务——
 * 'tools'（名册 + 守卫管线执行）与 'sessions'（日志 + 落账即广播）。
 * 「注册表、管线、日志」从此不是 runLoop 的参数，而是 ctx 上的服务：
 * loop 插件消费它们，permission 插件拦截前者，任何插件观察后者。
 * dsh 里它们是两个包（core/tools 与 core/session 贡献 ctx.tools / ctx.sessions，
 * 两个服务、两份 inject）；教学版合在一个插件——同一个能力簇（工具事实的
 * 产生与落账），拆开的时机是「两者开始被不同的插件独立替换」（s09 的 seam）。
 * @param tools - 装进名册的工具（defineTool 的产物）。
 * @returns 可挂载的插件。
 */
export function toolsSessionPlugin(tools: Tool[]): Plugin {
  return {
    name: 'tools-session',
    apply(ctx: Ctx) {
      const registry = registryOf(...tools)
      const log = new SessionLog()
      const sessions: SessionService = {
        log,
        append(event) {
          const logged = log.append(event)
          ctx.emit('session/event', { event: logged })
          return logged
        },
      }
      ctx.service('sessions', sessions)

      const toolsService: ToolsService = {
        registry,
        async execute(call, context) {
          const name = call.function.name
          const finish = (args: Record<string, unknown>, output: string, isError: boolean): ToolCallRecord => ({
            name,
            args,
            output,
            isError,
          })

          // 落账在取消检查前（与旧 runLoop 的顺序一致：tool/call 先落，取消则无 tool/result）。
          sessions.append({
            type: 'tool/call',
            turn: context.turn,
            callId: call.id,
            name,
            arguments: call.function.arguments,
          })
          context.signal?.throwIfAborted()

          let tool: Tool
          try {
            tool = registry.lookup(name)
          } catch (error) {
            return finish({}, `错误：${(error as Error).message}`, true)
          }

          let args: Record<string, unknown>
          try {
            args = JSON.parse(call.function.arguments) as Record<string, unknown>
          } catch (error) {
            return finish({}, `参数校验失败：arguments 不是合法 JSON（${(error as Error).message}）`, true)
          }
          if (typeof args !== 'object' || args === null || Array.isArray(args)) {
            return finish({}, `参数校验失败：arguments 根必须是 JSON 对象，实际是 ${describeType(args)}`, true)
          }
          const violations = validateArguments(tool.parameters, args)
          if (violations.length > 0) {
            return finish(args, `参数校验失败：${violations.join('；')}`, true)
          }

          // 拦截链（tools/pre-execute）：内置行为是真正的执行。拦截器全部委托时
          // 调用才到达执行；任何拦截器否决（不调 next()），链短路，工具体不运行。
          let executed = ''
          let executionError = false
          const final = await ctx.waterfallAsync(
            'tools/pre-execute',
            { callId: call.id, name, args },
            async (decision) => {
              try {
                executed = await tool.execute(decision.args, context.signal)
              } catch (error) {
                // 取消优先于错误回喂：循环都要停了，错误不落 tool/result（s05 的分流）。
                if (context.signal?.aborted) throw error
                executed = `工具执行出错：${(error as Error).message}`
                executionError = true
              }
              return decision
            },
          )

          if (final.veto !== undefined) {
            const record = finish(final.args, `守卫否决：${final.veto}`, true)
            sessions.append({ type: 'tool/result', callId: call.id, output: record.output })
            return record
          }
          sessions.append({ type: 'tool/result', callId: call.id, output: executed })
          return finish(final.args, executed, executionError)
        },
      }
      ctx.service('tools', toolsService)
    },
  }
}
