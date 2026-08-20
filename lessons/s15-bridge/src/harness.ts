/**
 * 最小组装：把六个真实 dsh 包挂成一棵能跑的插件树。对照 agent-spine-demo
 * 的 apply()（dsh 产品的「全家桶」版装配），这里砍到只剩 agent 循环的
 * 必需服务——AgentLoop 的 inject 表（agents/sessions/llm/tools/systemPrompt）
 * 就是这张清单的权威出处：
 *
 *   llm          @deepseek-ai/dsh-llm          adapter 注册表 + 流式调用 API
 *   sessions     @deepseek-ai/dsh-session       append-only 事件日志（s03 的真身）
 *   systemPrompt @deepseek-ai/dsh-system-prompt 系统提示装配（persona/工具 schema）
 *   tools        @deepseek-ai/dsh-tools         工具注册表 + 执行管线（s02 的真身）
 *   agents       @deepseek-ai/dsh-agent         Agent 接口与注册表
 *   agentLoop    @deepseek-ai/dsh-agent-loop    驱动器：turn/step 两级循环（s01 的真身）
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ScriptedAdapter } from './scripted-adapter.ts'

/** 剧本 adapter 占据的 provider 路由名；agent 的 options.provider 指到这里。 */
export const SCRIPTED_PROVIDER = 'scripted'

/**
 * 组装 mini harness 并返回可用的 ctx。挂载顺序不影响结果——cordis 会让每个
 * fiber 等待自己 inject 的服务就位——但按依赖分层排列更好读（与 agent-spine-demo
 * 的注释同一条理由）。工具注册与 adapter 注册都返回 disposer，本演示不持有。
 * @param adapter - 挂到 llm seam 上的剧本 adapter。
 * @param tools - 注册进工具名册的 ToolDefinition 列表。
 * @returns 挂载完成的 cordis Context。
 */
export async function assembleMiniHarness(
  adapter: ScriptedAdapter,
  tools: readonly ToolDefinition[],
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter([SCRIPTED_PROVIDER], adapter)
  for (const tool of tools) ctx.tools.register(tool)
  return ctx
}

/**
 * 创建本 harness 唯一的 agent 并返回其公开句柄。真实 dsh 里 agent 是
 * 显式创建的（产品形态多由 AgentLoop config 的 agents 数组在启动时声明，
 * 演示里走编程面 create）。
 * @param ctx - 已组装的 Context。
 * @param id - 会话标识；同一 id 的事件都落进这一条日志。
 * @returns 驱动循环用的 Agent 句柄（followup/whenIdle 都在它上面）。
 */
export function createMiniAgent(ctx: Context, id: string): Agent {
  return ctx.agentLoop.create(SessionId(id), { provider: SCRIPTED_PROVIDER, model: 'mini-scripted' })
}

/** 构造一条人类输入（s01 的「用户消息」在真包消息词汇里的样子）。 */
export function userPrompt(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
