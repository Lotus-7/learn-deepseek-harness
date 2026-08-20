import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as toolTodo from '@deepseek-ai/dsh-tool-todo'
import { assembleMiniHarness, createMiniAgent, userPrompt } from './harness.ts'
import { ScriptedAdapter, textTurn, toolCallTurn } from './scripted-adapter.ts'
import { TOOL_ROSTER } from './tools.ts'

/** 本课验证过的精确版本（npm view 逐包核实；见 README 的核实记录）。 */
const VERIFIED_PINS: Record<string, string> = {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-agent': '0.1.0-rc.8',
  '@deepseek-ai/dsh-agent-loop': '0.1.0-rc.8',
  '@deepseek-ai/dsh-llm': '0.1.0-rc.8',
  '@deepseek-ai/dsh-session': '0.1.0-rc.8',
  '@deepseek-ai/dsh-system-prompt': '0.1.0-rc.8',
  '@deepseek-ai/dsh-tool-todo': '0.1.0-rc.8',
  '@deepseek-ai/dsh-tools': '0.1.0-rc.8',
}

/** 已组装的 harness 汇总，测试结束后统一卸载。 */
const contexts: Context[] = []
afterAll(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
})

/** 组装一台最小 harness（剧本 + 全部工具），并登记以便统一卸载。 */
async function assemble(script: ReturnType<typeof textTurn>[]): Promise<{
  ctx: Context
  adapter: ScriptedAdapter
}> {
  const adapter = new ScriptedAdapter(script)
  const ctx = await assembleMiniHarness(adapter, TOOL_ROSTER)
  contexts.push(ctx)
  return { ctx, adapter }
}

/** 跑一轮「一次工具往返」：add(2,3) → 回喂 → 终答。 */
async function runRoundTrip(ctx: Context, adapter: ScriptedAdapter) {
  const agent = createMiniAgent(ctx, `rt-${adapter.requests.length}`)
  agent.followup(userPrompt('帮我算 2 + 3'))
  await agent.whenIdle()
  return agent
}

describe('组装：六个真实 dsh 包挂成一棵能跑的插件树', () => {
  it('服务就位：inject 表上的五个服务全部可用，adapter 占据 provider 路由', async () => {
    const { ctx } = await assemble([textTurn('ok')])
    expect(ctx.llm.listProviders()).toEqual([{ id: 'scripted', name: 'scripted' }])
    expect(ctx.tools).toBeTruthy()
    expect(ctx.sessions).toBeTruthy()
    expect(ctx.systemPrompt).toBeTruthy()
    expect(ctx.agentLoop).toBeTruthy()
  })

  it('defineTool 的 DSL 投影成模型可见的 JSON Schema', async () => {
    const { ctx, adapter } = await assemble([toolCallTurn('c0', 'add', { a: 1, b: 1 }), textTurn('ok')])
    await runRoundTrip(ctx, adapter)
    const names = adapter.requests[0]?.tools?.map(tool => tool.name)
    expect(names).toContain('add')
    expect(names).toContain('echo')
    const add = adapter.requests[0]?.tools?.find(tool => tool.name === 'add')
    expect(add?.parameters).toMatchObject({
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
    })
  })

  it('再挂一个真实 dsh 工具包（tool-todo）：todo_write 立即进入模型可见名册', async () => {
    const { ctx, adapter } = await assemble([textTurn('ok')])
    await ctx.plugin(toolTodo, { allowParallelInProgress: true })
    await runRoundTrip(ctx, adapter)
    const names = adapter.requests[0]?.tools?.map(tool => tool.name)
    expect(names).toContain('todo_write')
  })
})

describe('剧本往返：真包驱动的一次完整工具往返', () => {
  it('tool-call → 工具执行 → 结果回喂第二次请求 → 终答', async () => {
    const { ctx, adapter } = await assemble([
      toolCallTurn('call-add', 'add', { a: 2, b: 3 }),
      textTurn('2 + 3 = 5'),
    ])
    const agent = await runRoundTrip(ctx, adapter)

    // 两次模型调用：一次发工具调用，一次消化工具结果后终答
    expect(adapter.requests).toHaveLength(2)

    // 第二次请求的派生历史里有工具结果（model-visible ⟺ logged 的真包断言）
    const second = adapter.requests[1]?.messages
    const fed = second?.flatMap(m => m.content).find(b => b.type === 'tool-result')
    expect(fed).toMatchObject({ toolCallId: 'call-add', isError: false })
    expect(fed?.type === 'tool-result' && fed.content).toEqual([{ type: 'text', text: '5' }])

    // 会话日志记录了完整事件链（s03 词汇的真身）
    const types = agent.session.events.map(event => event.type)
    expect(types).toContain('turn/start')
    expect(types).toContain('user/message')
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')
    expect(types).toContain('assistant/message')
    expect(types).toContain('turn/end')
    const call = agent.session.events.find(event => event.type === 'tool/call')
    expect(call?.type === 'tool/call' && call.data).toMatchObject({
      name: 'add',
      arguments: '{"a":2,"b":3}',
    })
    // 终答落进日志
    const last = agent.session.events.findLast(event => event.type === 'assistant/message')
    expect(last?.type === 'assistant/message' && last.data.message.content)
      .toEqual([{ type: 'text', text: '2 + 3 = 5' }])
  })

  it('剧本耗尽响亮报错而不是静默重复', async () => {
    const { ctx, adapter } = await assemble([])
    const agent = createMiniAgent(ctx, 'exhausted')
    agent.followup(userPrompt('任何话'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    // 失败不出现在会话日志的工具面，也不炸进程：turn 结束即可
    expect(agent.session.events.some(event => event.type === 'turn/end')).toBe(true)
  })
})

describe('依赖：声明与安装一致', () => {
  const require = createRequire(import.meta.url)

  it('package.json 声明的每个 @deepseek-ai 依赖都钉在核实过的版本上', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    for (const [name, range] of Object.entries(manifest.dependencies as Record<string, string>)) {
      expect(VERIFIED_PINS[name], `${name} 需要先 npm view 核实再写进依赖`).toBeDefined()
      expect(range).toBe(VERIFIED_PINS[name])
    }
  })

  it('实际解析到的包版本与声明逐个相等', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    for (const name of Object.keys(manifest.dependencies as Record<string, string>)) {
      const entry = require.resolve(name)
      const version = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version
      expect(version, `${name} 安装版本漂移`).toBe(VERIFIED_PINS[name])
    }
  })
})
