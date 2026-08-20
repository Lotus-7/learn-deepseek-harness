import type { ChatMessage } from '@learn-dsh/mock-model'
import type { AsyncWaterfallEvent, Plugin } from './cordis'
import type { TurnEndReason } from './log'

// 本插件的事件与服务目录扩展。事件键用 dsh 的真名：
// agent/pre-step——步骤开始前的瀑布。dsh 的载荷还带 agent/messages/signal 且
// 决议可 reject（packages/core/agent/src/runtime-types.ts），教学版收最小面：
// {turn, step} 的观察与委托媒介。生产者（本插件）声明事件，消费者
// （compaction 插件等）只挂监听——与 dsh「事件表在生产者包」同构。
declare module './cordis.js' {
  interface EventMap {
    /**
     * 一次模型步骤开始前的拦截点（loop 插件在每个步骤边界发起）。
     * 监听者可在此做步骤前的准备（压缩、预算、审计），然后必须 next() 委托
     * ——不调即短路。教学版的短路只跳过链上后续监听器：loop 丢弃瀑布
     * 返回值、请求照发，这条瀑布是观察与准备媒介，不是「拒绝下一步」的
     * 决议点。dsh 对应 packages/core/agent/src/runtime-types.ts 的
     * 'agent/pre-step'（@mode waterfall）：决议是 PreStepDecision，可 reject
     * 整个步骤且 loop 尊重拒绝（packages/core/agent-loop/src/agent.ts 的
     * preStep）——教学版未收这一层；packages/compaction/compaction-basic
     * 挂它做 step pressure。
     * @mode waterfall-async
     */
    'agent/pre-step': AsyncWaterfallEvent<{ turn: number; step: number }>
  }
  interface ServiceMap {
    /** loop 驱动服务：跑一个 turn（本插件贡献）。 */
    agent: AgentService
  }
}

/** 'agent' 服务：驱动一个 turn。dsh 对应 ctx.agentLoop（AgentFactory + driver）。 */
export interface AgentService {
  /**
   * 跑一个 turn：用户输入 → 模型 →（工具 → 结果 → 模型）* → 最终回答。
   * 与 s06 的 runLoop 逐行为等价（测试钉住整份日志逐事件相等），差别只在
   * 「依赖从哪来」：模型、工具、会话都是 ctx 服务，压缩不是参数而是
   * agent/pre-step 瀑布上有没有人。日志来自 'sessions' 服务并在其上续写
   * ——连续调用 run 就是多轮对话（旧版靠 options.log 参数续写）。
   * @param userText - 本轮的用户输入。
   * @param options.signal - 本次 turn 的取消 signal（s05 语义照旧）。
   * @returns 整段对话的派生历史：正常完成时最后一条是最终回答；
   * 取消时是截至取消的事实（收口 turn/end(aborted) 后正常返回）。
   * @throws 模型/适配器层错误（收口 turn/end(error) 后原样上抛）；
   * maxSteps 耗尽（不写 turn/end，留下未闭合的 turn）；
   * 服务缺失（model/tools/sessions 任一未装配，响亮报错、日志零事件）。
   */
  run(userText: string, options?: { signal?: AbortSignal }): Promise<ChatMessage[]>
}

/** loop 插件配置：maxSteps 保险丝（s01 以来的语义）。 */
export interface LoopPluginOptions {
  /** 模型连续请求工具的步数上限，默认 20。 */
  maxSteps?: number
}

/**
 * loop 驱动插件（五件套之五）：runLoop 从「主程序」变成「协作的驱动者」。
 * 取舍（为什么是插件而不是组装函数）：做成消费 ctx 的普通函数也能跑，但那样
 * 驱动器就不是可替换、可卸载的单元——「换一个 loop」（比如换成支持流式或
 * 并行工具调动的驱动）就得改组装代码；作为插件，换驱动 = 换一行装配。
 * dsh 同款立场：默认驱动 agent-loop 本身是插件（AgentLoop extends Service，
 * `static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']`——
 * 驱动器声明它消费谁），「主程序」只剩装配清单。
 * 每步的三次协作：发起 agent/pre-step 瀑布（压缩等挂这里）、emit agent/step
 * （观察者挂这里）、把工具调用交给 'tools' 服务执行（拦截链在它里面）——
 * 循环体本身只剩「调模型、决定停不停」。
 * @param options - 保险丝配置。
 * @returns 可挂载的插件。
 */
export function loopPlugin(options: LoopPluginOptions = {}): Plugin {
  const maxSteps = options.maxSteps ?? 20
  return {
    name: 'loop',
    apply(ctx) {
      ctx.service('agent', {
        async run(userText: string, runOptions: { signal?: AbortSignal } = {}): Promise<ChatMessage[]> {
          const signal = runOptions.signal
          const sessions = ctx.get('sessions')
          const log = sessions.log
          const tools = ctx.get('tools')
          // 模型在 turn 开始时解析一次：turn 中途卸载 model 插件不属于支持的场景
          // （dsh 里 inject 声明的依赖消失时，依赖它的插件会被框架自动卸载）。
          const model = ctx.get('model')
          const turn = log.nextTurn()
          /** 本 turn 是否已写 turn/end：三条出口至多收口一次（s05 的竞态规矩）。 */
          let ended = false
          const endTurn = (reason: TurnEndReason): ChatMessage[] => {
            ended = true
            sessions.append({ type: 'turn/end', turn, reason })
            return log.deriveMessages()
          }

          sessions.append({ type: 'turn/start', turn })
          sessions.append({ type: 'user/message', content: userText })

          try {
            for (let step = 1; step <= maxSteps; step++) {
              // 取消检查点 ①：步骤边界（s05 语义照旧）。
              signal?.throwIfAborted()

              // 压缩检查点不再看参数：发起步骤前瀑布，压缩/预算/审计插件挂上面；
              // 没有人挂时链空转（等价旧版「不传 compaction」）。每步至多一次——
              // 压缩器自己保证（maybeCompact 的触发语义）。
              await ctx.waterfallAsync('agent/pre-step', { turn, step }, (probe) => Promise.resolve(probe))
              ctx.emit('agent/step', { turn, step })

              // 工具 schema 每步重取（s12）：技能可以在 turn 中途加载并往名册
              // 追加工具（load_skill 的附加工具），下一步请求就要看得见。
              // dsh 同款节奏：Turn flow 里 assemble prompt sections + tool
              // schemas 发生在每个 step（docs/architecture.md），不是 turn 一次。
              const schemas = tools.registry.schemas()
              let response: Awaited<ReturnType<typeof model>>
              try {
                response = await model(log.deriveMessages(), schemas)
              } catch (error) {
                // 致命：模型/适配器层抛错。收口后原样上抛（s05 的分流）。
                endTurn('error')
                throw error
              }
              sessions.append({ type: 'assistant/message', message: response.message })

              if (response.finishReason !== 'tool_calls' || !response.message.tool_calls) {
                return endTurn('completed')
              }
              for (const call of response.message.tool_calls) {
                // 落账（tool/call + tool/result）与拦截链都在 'tools' 服务里——
                // loop 不再直接碰日志的工具事件，这是插件化的实质变化。
                // 取消时服务上抛，tool/result 不落账（s05 语义照旧）。
                await tools.execute(call, { turn, signal })
              }
            }
          } catch (error) {
            // 取消：不是错误，是第三条出口（先定的结局不改写，s05 的竞态规矩）。
            if (signal?.aborted && !ended) return endTurn('aborted')
            throw error
          }
          // 保险丝在 try/catch 之外上抛（s05 的语义：熔断错误不被取消竞态吞掉）。
          throw new Error(`模型连续 ${maxSteps} 步都在请求工具，超出 maxSteps 上限，循环中止`)
        },
      })
    },
  }
}
