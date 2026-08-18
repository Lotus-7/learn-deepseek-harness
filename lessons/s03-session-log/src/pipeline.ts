import type { ToolCall } from '@learn-dsh/mock-model'
import type { ToolRegistry } from './registry'
import type { Tool } from './tools'

/** 一次工具调用的留痕：postExecute 钩子收到它。 */
export interface ToolCallRecord {
  name: string
  args: Record<string, unknown>
  output: string
  /** 校验失败 / 守卫否决 / 执行抛错时为 true；这些结果同样回喂模型。 */
  isError: boolean
}

/**
 * 执行前守卫：在 execute 之前询问，返回否决原因（string）即否决这次调用，
 * 返回 undefined 放行。dsh 对应 tools/pre-execute 瀑布里返回 deny 的监听器，
 * 以及只能否决、不能推翻别人否决的 ctx.tools.guard()。
 */
export type PreExecuteHook = (tool: Tool, args: Record<string, unknown>) => string | undefined

/**
 * 执行后钩子：每次调用（含失败）都到这里，用于记录调用、日志、审计。
 * dsh 对应 tools/post-execute（可改写结果）与 tools/result（只观察最终结果）。
 */
export type PostExecuteHook = (record: ToolCallRecord) => void

/** 挂在管线上的钩子集合，两个数组都按序执行。 */
export interface PipelineHooks {
  preExecute?: PreExecuteHook[]
  postExecute?: PostExecuteHook[]
}

/** 检查一个值是否符合 schema 声明的 JSON 类型。 */
function matchesType(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    default:
      return true // 本课不检查的类型关键字（如 null）一律放行
  }
}

/** 给违规报告用的值描述：类型 + JSON 值，模型能据此修正。 */
function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array（${JSON.stringify(value)}）`
  return `${typeof value}（${JSON.stringify(value)}）`
}

/**
 * 轻量 JSON-Schema 检查：只看 required 缺失与顶层属性 type 不符。
 * @param parameters - 工具声明的参数 schema（JSON Schema 对象形态）。
 * @param args - 模型给的参数。
 * @returns 违规说明列表；空数组 = 通过。
 */
export function validateArguments(
  parameters: Record<string, unknown>,
  args: Record<string, unknown>,
): string[] {
  const violations: string[] = []
  const properties = (parameters.properties ?? {}) as Record<string, { type?: string }>
  for (const name of (parameters.required as string[] | undefined) ?? []) {
    if (!(name in args)) violations.push(`缺少必填参数 ${name}`)
  }
  for (const [name, value] of Object.entries(args)) {
    const expected = properties[name]?.type
    if (expected !== undefined && !matchesType(expected, value)) {
      violations.push(`参数 ${name} 应为 ${expected}，实际是 ${describeType(value)}`)
    }
  }
  return violations
}

/** 收尾：组装留痕并通知所有 postExecute 钩子（失败调用也留痕）。 */
function finish(
  name: string,
  args: Record<string, unknown>,
  output: string,
  isError: boolean,
  hooks: PipelineHooks,
): ToolCallRecord {
  const record: ToolCallRecord = { name, args, output, isError }
  for (const hook of hooks.postExecute ?? []) hook(record)
  return record
}

/**
 * 守卫执行管线，替代 s01 的「find 到就 execute」：
 * ① 参数校验（required + type）② preExecute 守卫（可否决）③ execute ④ postExecute 留痕。
 * 四种失败——未知名、参数不是合法 JSON（含根不是对象）、校验不过、守卫否决——都不是进程崩溃：
 * 它们成为 role:'tool' 的结果消息回喂模型，模型看得见、可修正重试。
 * dsh 对应 ToolRuntime.execute 的 pre-execute → execute → post-execute 管线
 * （packages/core/tools/src/index.ts）。
 * @param registry - 工具名册。
 * @param call - 模型发起的一次 tool call。
 * @param hooks - 挂在管线上的守卫与留痕钩子。
 * @returns 这次调用的留痕；output 就是回喂模型的 tool 结果文本。
 */
export async function executeToolCall(
  registry: ToolRegistry,
  call: ToolCall,
  hooks: PipelineHooks = {},
): Promise<ToolCallRecord> {
  const name = call.function.name

  let tool: Tool
  try {
    tool = registry.lookup(name)
  } catch (error) {
    return finish(name, {}, `错误：${(error as Error).message}`, true, hooks)
  }

  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>
  } catch (error) {
    return finish(name, {}, `参数校验失败：arguments 不是合法 JSON（${(error as Error).message}）`, true, hooks)
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return finish(name, {}, `参数校验失败：arguments 根必须是 JSON 对象，实际是 ${describeType(args)}`, true, hooks)
  }

  const violations = validateArguments(tool.parameters, args)
  if (violations.length > 0) {
    return finish(name, args, `参数校验失败：${violations.join('；')}`, true, hooks)
  }

  for (const guard of hooks.preExecute ?? []) {
    const veto = guard(tool, args)
    if (veto !== undefined) {
      return finish(name, args, `守卫否决：${veto}`, true, hooks)
    }
  }

  try {
    const output = await tool.execute(args)
    return finish(name, args, output, false, hooks)
  } catch (error) {
    return finish(name, args, `工具执行出错：${(error as Error).message}`, true, hooks)
  }
}
