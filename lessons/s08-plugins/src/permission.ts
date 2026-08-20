import type { Tool } from './tools'
import type { PreExecuteHook } from './pipeline'

/**
 * 权限三态决策：放行、否决、交给人裁决。
 * dsh 对应 PreToolDecision（packages/core/tools/src/index.ts）：
 * allow 直跑、deny 连同原因落成错误结果、ask 等 `ctx.approval` 给出
 * `allowed-once` 才放行——非授权结果一律当 deny 处理。
 */
export type PermissionDecision = 'allow' | 'deny' | 'ask'

/** 递给 {@link AskUser} 的问题：模型想调什么、带什么参数、为什么需要人裁决。 */
export interface AskQuestion {
  tool: string
  args: Record<string, unknown>
  /** 守卫给出的人话理由：为什么这个调用没有直接放行。 */
  reason: string
}

/**
 * 假想中的用户：对一次审批请求回答 allow 或 deny。
 * 真实产品里这一头接终端弹窗、Web UI 或 ACP 客户端；演示与测试用剧本化的假用户。
 * dsh 对应监听 `approval/request` 瀑布的 answerer（如 packages/acp/acp 的
 * requestPermission 桥），或 `ctx.userQuestions` 提供商。
 */
export type AskUser = (question: AskQuestion) => Promise<'allow' | 'deny'>

/** 最终裁决从哪里来：规则表 / 未匹配默认 / 用户允许 / 用户拒绝 / 无通道退化 / 会话记忆。 */
export type DecisionVia = 'rule' | 'default' | 'ask-allowed' | 'ask-denied' | 'ask-unavailable' | 'cache'

/** 决策轨迹条目：挂上守卫后每一次工具调用的最终裁决与理由（放行也记）。 */
export interface PermissionTraceEntry {
  tool: string
  /** 最终裁决：allow = 放行执行，deny = 否决并把理由回喂模型。 */
  outcome: 'allow' | 'deny'
  via: DecisionVia
  reason: string
}

/** 组装一个权限守卫的选项。 */
export interface PermissionOptions {
  /**
   * 规则表：工具名（或 `'*'` 通配）→ 三态决策。先精确名，后通配。
   * dsh 的对应物不是这张表，而是「sandbox 模式 + 审批策略」两个独立旋钮
   * （permission-presets 把它们打包成用户面上的预设）。
   */
  rules?: Record<string, PermissionDecision>
  /** 审批回调：裁决为 ask 时向它要答案；不提供时 ask 按 deny 处理（fail-safe）。 */
  askUser?: AskUser
  /**
   * 规则未匹配时的默认裁决，缺省 `'ask'`：未知工具交给人，而不是默默放行或默默挡死。
   * dsh 同款立场：默认 ask，但没有任何 answerer 时链落到 fail-closed 的拒绝。
   */
  defaultDecision?: PermissionDecision
  /**
   * 同一工具在本守卫的生命周期里记住首次最终裁决，之后不再重复裁决。
   * 缺省 false——逐次裁决与 dsh 的 `allowed-once` 对齐：一次授权只覆盖那一次调用，
   * 会话级记忆省事，但授权会漂移到后来变了性质的调用上。
   */
  remember?: boolean
}

/** 带只读轨迹的守卫函数：就是 s02 管线的一个 preExecute 钩子。 */
export interface PermissionGuard {
  (tool: Tool, args: Record<string, unknown>): Promise<string | undefined>
  /** 决策轨迹：每次调用的最终裁决与理由，演示与测试据此打印、断言。 */
  readonly trace: readonly PermissionTraceEntry[]
}

/** 把裁决与理由落成回喂文本；否决文本以「权限拒绝：」开头，模型能认出类别并改道。 */
function veto(reason: string): string {
  return `权限拒绝：${reason}`
}

/**
 * 创建一个权限守卫：规则表（工具名/通配 → allow/deny/ask）+ 可选 askUser 回调，
 * 实现为 s02 管线的 pre-execute 钩子——挂在 executeToolCall 的 preExecute 数组里，
 * 工具体永远不会看到一个没被放行的调用。
 *
 * 三条 fail-safe 约定：
 * 1. 规则未匹配默认 ask（不是 allow：忘配的工具不该默默放行）；
 * 2. ask 但没有 askUser 回调，按 deny 处理（没有通道就拒绝，不猜用户意图）；
 * 3. askUser 自己抛错，同样按 deny 处理（通道坏了，问题要失败在关着的一侧）。
 * dsh 里这三条分别对应默认 policy `'ask'`、无 answerer 时的 `'unavailable'`、
 * 抛错 answerer 的 fail-closed 归一（packages/interaction/user-approval/src/index.ts）。
 *
 * @param options - 规则表、审批回调、默认裁决、会话记忆开关。
 * @returns 可挂到 preExecute 的守卫函数，附带只读 `trace`。
 */
export function createPermissionGuard(options: PermissionOptions = {}): PermissionGuard {
  const rules = options.rules ?? {}
  const fallback = options.defaultDecision ?? 'ask'
  const trace: PermissionTraceEntry[] = []
  const remembered = new Map<string, PermissionTraceEntry>()

  const guard: PermissionGuard = Object.assign(
    async (tool: Tool, args: Record<string, unknown>): Promise<string | undefined> => {
      // 会话记忆：remember 开着才可能有值；命中的裁决直接复用，不再问人。
      const cached = remembered.get(tool.name)
      if (cached !== undefined) {
        const entry: PermissionTraceEntry = {
          tool: tool.name,
          outcome: cached.outcome,
          via: 'cache',
          reason: `本会话已记住 ${tool.name} 的裁决（${cached.outcome === 'allow' ? '允许' : '拒绝'}），不再重复询问`,
        }
        trace.push(entry)
        return cached.outcome === 'allow' ? undefined : veto(entry.reason)
      }

      const rule = rules[tool.name] ?? rules['*']
      const decision: PermissionDecision = rule ?? fallback
      const source: DecisionVia = rule !== undefined ? 'rule' : 'default'

      let outcome: 'allow' | 'deny'
      let via: DecisionVia = source
      let reason: string
      switch (decision) {
        case 'allow':
          outcome = 'allow'
          reason =
            source === 'rule'
              ? `规则 ${tool.name} → allow，直接放行`
              : `未匹配任何规则，默认 ${fallback} → 放行`
          break
        case 'deny':
          outcome = 'deny'
          reason =
            source === 'rule'
              ? `策略把 ${tool.name} 标记为 deny；如需完成目标，请改用其他工具`
              : `未匹配任何规则，默认 ${fallback}，按拒绝处理；请改用明确允许的工具`
          break
        case 'ask': {
          if (options.askUser === undefined) {
            outcome = 'deny'
            via = 'ask-unavailable'
            reason = `${tool.name} 需要用户审批，但没有可用的审批通道（fail-safe，按拒绝处理）`
            break
          }
          let answer: 'allow' | 'deny'
          try {
            answer = await options.askUser({
              tool: tool.name,
              args,
              reason: `${tool.name} 未获预授权，执行前需要用户确认`,
            })
          } catch (error) {
            // 审批通道自身出错：问题失败在关着的一侧，而不是把异常漏给工具调用方。
            outcome = 'deny'
            via = 'ask-unavailable'
            reason = `审批通道出错（${(error as Error).message}），按拒绝处理`
            break
          }
          if (answer === 'allow') {
            outcome = 'allow'
            via = 'ask-allowed'
            reason = `规则 ${tool.name} → ask，用户批准了本次执行`
          } else {
            outcome = 'deny'
            via = 'ask-denied'
            reason = `规则 ${tool.name} → ask，用户拒绝了 ${tool.name} 的执行；请改用允许清单内的工具完成目标`
          }
          break
        }
      }

      const entry: PermissionTraceEntry = { tool: tool.name, outcome, via, reason }
      trace.push(entry)
      if (options.remember === true) remembered.set(tool.name, entry)
      return outcome === 'allow' ? undefined : veto(reason)
    },
    {
      get trace(): readonly PermissionTraceEntry[] {
        return trace
      },
    },
  )
  return guard
}
