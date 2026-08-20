import type { Ctx } from './cordis'
import { defineTool, type Tool } from './tools'
import {
  SubagentError,
  type SubagentErrorCode,
  type SubagentHandle,
  type SubagentOutcome,
} from './subagent-service'

/**
 * delegate 工具——子代理能力的模型面 Consumer。
 *
 * 父代理调用它 → **阻塞等子代理跑完**（await handle.result，dsh 对应
 * tool-subagent 的 foreground 路径："A foreground call passes the execution signal
 * through startup and execution, awaits run.result, and always awaits run.dispose()
 * before reporting"，packages/subagent/tool-subagent/README.md）→ 子代理的最终
 * 回答作为 tool/result 回喂父。父的日志因此只多**一对** tool/call + tool/result
 * ——子的全部中间事件留在子的私有日志里（隔离的可观察面，dsh 原文："the
 * parent's log records only the spawn tool/call and its tool/result, while child
 * steps and tool calls remain outside the parent log"，capability-seam 决策笔记）。
 *
 * 回喂文本带**委派开销**（子的事件数 / 轮次 / 用过的工具）：父看得见这次委派
 * 花了多少，看不见（也不用看）子的过程。
 *
 * **防无限递归的两道闸**：
 *
 * 1. **装配期**：defaultTools 白名单不得含 delegate 自己——构造当场抛错
 *    （fail loud）。子代理的默认工具集因此永远不含委派能力；「默认继承的是
 *    白名单而非全量」，委派即缩小爆炸半径。
 * 2. **运行期**：调用方（模型）显式在 args.tools 里点名 delegate 是合法的——
 *    受限的工具集允许递归，深度上限来兜底。教学版的深度经**克隆链**传递：
 *    子拿到的是 depth+1 的 delegate 克隆（同一个工厂、同一个容器、不同的层号）
 *    ——dsh 的工具执行上下文携带代理身份（exec.agent → delegationDepthOf），
 *    教学版工具没有这层上下文，深度随工具实例走。
 *
 * 与 s09/s10 的 Consumer 同款立场：本文件只 import Definition（subagent-service.ts）
 * 的词汇与错误码，绝不 import provider——换 provider 零改动。
 */

/** 契约内失败的模型面补救语（REMEDIES 模式，沿 fs-tools / world-tools）。 */
const REMEDIES: Partial<Record<SubagentErrorCode, string>> = {
  SUBAGENT_DEPTH_EXCEEDED: '请不再向下委派，改用你当前可用的工具完成任务',
}

/** delegate 工具的配置（插件配置的教学形态：工厂参数）。 */
export interface DelegateToolOptions {
  /** 模型面工具名，默认 delegate。 */
  readonly name?: string
  /**
   * 子代理的默认工具白名单：显式名单（没有 `*` 通配、不含隐藏默认）。
   * **不得含工具自己**——含即构造期抛错（防无限递归的第一道闸是装配约定）。
   * 运行时模型可用 args.tools 显式点名覆盖（此时允许 delegate，由深度上限拦）。
   */
  readonly defaultTools: readonly string[]
  /**
   * 绝对深度上限，默认 2：顶层(0) → 子(1) → 孙(2) 放行，曾孙(3) 拒绝。
   * dsh 的 tool-subagent 默认 3——同一个「小而有限的默认」立场。
   */
  readonly maxDepth?: number
  /**
   * 本层委派者的深度：顶层装配为 0（默认）；克隆链内部逐层 +1，
   * 调用方不需要传。
   */
  readonly depth?: number
}

/**
 * 组装 delegate 工具。
 * @param ctx - 委托方（父）的装配容器：执行时经它解析 `tools`（按名取白名单工具）
 *   与 `subagents`（spawn）。
 * @param options - 见 {@link DelegateToolOptions}。
 * @returns delegate 工具（defineTool 产物）。
 * @throws defaultTools 含工具自己的名字（装配错误当场爆，不带病上岗）。
 */
export function delegateTool(ctx: Ctx, options: DelegateToolOptions): Tool {
  const name = options.name ?? 'delegate'
  const maxDepth = options.maxDepth ?? 2
  const depth = options.depth ?? 0
  const defaults = [...options.defaultTools]
  if (defaults.includes(name)) {
    throw new Error(
      `delegate 工具（"${name}"）的默认白名单不得包含自己（收到：${defaults.join('、')}）——` +
        '子代理的默认工具集不含委派能力是防无限递归的第一道闸；确需递归委派时由调用方在 tools 参数里显式点名',
    )
  }

  const delegate = defineTool({
    name,
    description:
      '把一段自包含任务委派给一个子代理（独立上下文、受限工具集）并等待其完成，返回其最终回答与委派开销。' +
      '子代理看不到当前对话：任务文本必须带全它需要的上下文。子的中间步骤不进入本对话。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '交给子代理的完整自包含任务（子代理看不到当前对话）',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            '子代理可用的工具名白名单；缺省用默认白名单（不含 delegate——默认不可递归委派）',
        },
      },
      required: ['task'],
    },
    execute: async (args, signal) => {
      const registry = ctx.get('tools').registry

      // 白名单解析：显式名单（可含 delegate，见克隆链注释）或默认白名单（必不含）。
      const names: readonly string[] = Array.isArray(args.tools)
        ? args.tools.map(String)
        : defaults
      const toolset = names.map((toolName) =>
        toolName === name
          ? // 下一层的 delegate 克隆：同一个工厂与容器，层号 +1——递归的深度
            // 就挂在工具实例上（dsh 挂在 exec.agent 的会话头上，见文件头注释）。
            delegateTool(ctx, { ...options, depth: depth + 1 })
          : registry.lookup(toolName),
      )

      // spawn 的契约内拒绝（深度超限）补一句「下一步怎么办」再上抛——
      // 由 s02/s08 管线落成回喂模型的 tool/result（可恢复，循环不崩）。
      let handle: SubagentHandle
      try {
        handle = ctx.get('subagents').spawn({ task: String(args.task), toolset, depth, maxDepth, signal })
      } catch (error) {
        throw remediateSubagentError(error)
      }
      let outcome: SubagentOutcome
      try {
        outcome = await handle.result // 阻塞等子代理跑完——父的这一个工具调用就是子的全部生命周期
      } catch (error) {
        // seam 表达不了的基础设施故障（run.result 本不该 reject；这条分支是防线）。
        handle.dispose()
        throw error
      }
      handle.dispose() // 收完结果即卸载子装配（dsh：foreground calls always dispose）

      if (outcome.stopReason !== 'completed') {
        // 子未正常完成：不是成功，但已产出的部分照喂（dsh：partial output is not
        // success, but the preserved partial answer still reaches the parent）。
        return [
          `子代理 ${handle.id} 未正常完成（${outcome.stopReason}；${outcome.turns} 轮 / ${outcome.eventCount} 个事件）。`,
          `其已产出的回答（可能不完整）：${outcome.answer || '（无输出）'}`,
        ].join('\n')
      }
      return [
        `子代理 ${handle.id} 已完成（委派开销：${outcome.turns} 轮 / ${outcome.eventCount} 个事件；使用工具 ${outcome.toolsUsed.join('、') || '无'}）。`,
        `子的最终回答：`,
        outcome.answer,
      ].join('\n')
    },
  })
  return delegate
}

/**
 * 捕获契约内拒绝并补补救语（不改 seam 的原始信息）：由 s02/s08 管线落成回喂
 * 模型的 tool/result（可恢复，循环不崩）。
 * @param error - spawn 抛出的任意值。
 * @returns 带补救语的新 SubagentError；无补救语或非 SubagentError 的原样返回。
 */
export function remediateSubagentError(error: unknown): unknown {
  if (!(error instanceof SubagentError)) return error
  const remedy = REMEDIES[error.code]
  if (remedy === undefined) return error
  return new SubagentError(`${error.message} —— ${remedy}`, error.code)
}
