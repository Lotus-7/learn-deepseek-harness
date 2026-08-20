import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx } from './cordis'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { permissionPlugin } from './plugin-permission'
import { loopPlugin } from './plugin-loop'
import { echoTool } from './tools'
import { WorkflowError, type JobDefinition, type JobSnapshot } from './workflow-service'
import { workflowPlugin } from './workflow-plugin'
import { workflowTools } from './workflow-tools'
import type { LoggedEvent } from './log'

/**
 * 本课新增行为的测试（二）：后台工作流。钉六件事——状态机各态可观察、
 * start 登记不推进（立即继续）、collect 三态语义（未完成不阻塞 / 终态拿结果 /
 * 不存在响亮报错）、失败路径落 failed 快照而非异常、推进与主对话的 tool/result
 * 事件一一对齐、终态 collect 幂等。
 */

/** 三步走完的计数工作流（2 yield + return = 3 次 advance 到终态）。 */
function countingWorkflow(): JobDefinition {
  return {
    kind: 'count',
    description: '测试用三步工作流',
    run: async function* () {
      yield '第一步'
      yield '第二步'
      return '计数完成'
    },
  }
}

/** 第二步抛错的工作流：failed 路径的样本。 */
function failingWorkflow(): JobDefinition {
  return {
    kind: 'fail',
    description: '测试用失败工作流',
    run: async function* () {
      yield '会失败的第一步'
      throw new Error('第二步Boom')
    },
  }
}

/**
 * 装配测试环境：工作流工具 + 可选的 echo（推进对齐用例的主对话工具）。
 * @param script - 剧本响应序列。
 * @param definitions - 装配的工作流定义清单。
 */
function assemble(script: readonly ModelResponse[], definitions: readonly JobDefinition[]): Ctx {
  const ctx = new Ctx()
  ctx.mount(modelPlugin(createMockModel([...script])))
  ctx.mount(toolsSessionPlugin([echoTool, ...workflowTools(ctx)]))
  ctx.mount(permissionPlugin({ rules: { '*': 'allow' } }))
  ctx.mount(workflowPlugin(definitions))
  ctx.mount(loopPlugin())
  return ctx
}

/** 取日志里全部 tool/result 的输出文本。 */
function resultTexts(events: readonly LoggedEvent[]): string[] {
  return events.filter((event) => event.type === 'tool/result').map((event) => event.output)
}

describe('start：登记不推进，立即返回 pending', () => {
  it('start 返回 pending 快照；snapshotOf 不推进；未知 kind 响亮报错', () => {
    const ctx = assemble([], [countingWorkflow()])
    const workflows = ctx.get('workflows')
    const snapshot = workflows.start('count', '/tmp')
    expect(snapshot).toMatchObject({ id: 'job-1', kind: 'count', status: 'pending', progress: [] })
    // 观察不推进：start 之后快照仍是 pending。
    expect(workflows.snapshotOf('job-1').status).toBe('pending')
    // 编号会话内单调递增。
    expect(workflows.start('count').id).toBe('job-2')
    try {
      workflows.start('ghost')
      expect.unreachable('未知 kind 应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError)
      expect((error as WorkflowError).code).toBe('WORKFLOW_KIND_UNKNOWN')
      expect((error as Error).message).toContain('可用：count')
    }
  })
})

describe('状态机与 collect 语义：pending → running → done', () => {
  it('每次 collect 推一步：running（带进度）→ done（带结果）；终态后再 collect 幂等', async () => {
    const ctx = assemble([], [countingWorkflow()])
    const workflows = ctx.get('workflows')
    workflows.start('count')
    // countingWorkflow = 2 个进度步骤 + 1 个 return：三次 collect 各推一拍。
    const first = await workflows.collect('job-1')
    // 未完成时返回当前状态（不阻塞）：快照是 running + 已走步骤。
    expect(first.status).toBe('running')
    expect(first.progress).toEqual(['第一步'])
    const second = await workflows.collect('job-1')
    expect(second.status).toBe('running')
    expect(second.progress).toEqual(['第一步', '第二步'])
    const third = await workflows.collect('job-1')
    expect(third.status).toBe('done')
    expect(third.progress).toEqual(['第一步', '第二步'])
    expect(third.result).toBe('计数完成')
    // 终态 collect 幂等：同一份终态快照，不再有第四步。
    expect(await workflows.collect('job-1')).toEqual(third)
  })

  it('collect 不存在的 id → WORKFLOW_JOB_UNKNOWN（列出现存编号）', async () => {
    const ctx = assemble([], [countingWorkflow()])
    try {
      await ctx.get('workflows').collect('job-9')
      expect.unreachable('不存在的 id 应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError)
      expect((error as WorkflowError).code).toBe('WORKFLOW_JOB_UNKNOWN')
      expect((error as Error).message).toContain('现存：')
    }
  })

  it('工作流体抛错 → failed 终态快照（collect 拿快照，不是异常）', async () => {
    const ctx = assemble([], [failingWorkflow()])
    const workflows = ctx.get('workflows')
    workflows.start('fail')
    await workflows.collect('job-1') // 第一步 yield
    const failed = await workflows.collect('job-1') // 第二步 throw
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('第二步Boom')
    expect(failed.result).toBeUndefined()
    // failed 与 done 同为终态：再 collect 幂等。
    expect(await workflows.collect('job-1')).toEqual(failed)
  })
})

describe('推进对齐：主对话每件工具实事推进一步', () => {
  it('start 后每个 tool/result 落账推进 job 一拍；assistant 叙述不推进', async () => {
    const script: ModelResponse[] = [
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('s1', 'start_job', { kind: 'count' })] },
        finishReason: 'tool_calls',
      },
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('e1', 'echo', { text: '干活' })] },
        finishReason: 'tool_calls',
      },
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('e2', 'echo', { text: '再干' })] },
        finishReason: 'tool_calls',
      },
      { message: { role: 'assistant', content: '收工。' }, finishReason: 'stop' },
    ]
    const ctx = assemble(script, [countingWorkflow()])
    await ctx.get('agent').run('挂个 job 然后干两件活。')
    // start_job 的 tool/result 是第 1 拍（pending→running + yield1）；
    // 两个 echo 的 tool/result 是第 2、3 拍——第 3 拍 return，job 到达 done。
    const snapshot: JobSnapshot = ctx.get('workflows').snapshotOf('job-1')
    expect(snapshot.status).toBe('done')
    expect(snapshot.progress).toEqual(['第一步', '第二步'])
    expect(snapshot.result).toBe('计数完成')
  })
})

describe('工具面：start_job / collect_job 的回喂三态', () => {
  it('running 回喂进度与「不阻塞」；done 回喂结果；不存在回喂补救语', async () => {
    const script: ModelResponse[] = [
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('s1', 'start_job', { kind: 'count' })] },
        finishReason: 'tool_calls',
      },
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'collect_job', { id: 'job-1' })] },
        finishReason: 'tool_calls',
      },
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('c2', 'collect_job', { id: 'job-1' })] },
        finishReason: 'tool_calls',
      },
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('c3', 'collect_job', { id: 'job-9' })] },
        finishReason: 'tool_calls',
      },
      { message: { role: 'assistant', content: '收工。' }, finishReason: 'stop' },
    ]
    const ctx = assemble(script, [countingWorkflow()])
    await ctx.get('agent').run('挂 job 并收集三次。')
    const texts = resultTexts(ctx.get('sessions').log.events)
    expect(texts[0]).toContain('已登记后台 job job-1（count）：状态 pending')
    expect(texts[1]).toContain('running（后台进行中，本次 collect 不阻塞）')
    // 第 2 次 collect 推第 2 拍后取快照（running）；它自己的 tool/result 落账
    // 又推第 3 拍（return → done）——第 3 次 collect 看到的已是终态。
    expect(texts[2]).toContain('done——最终结果：')
    expect(texts[2]).toContain('计数完成')
    expect(texts[3]).toContain('没有编号为 "job-9" 的后台 job')
    expect(texts[3]).toContain('请检查 job 编号')
  })
})

describe('装配防线：工作流 kind 重复注册是装配错误', () => {
  it('同名 kind 二次注册 → 插件挂载当场抛', () => {
    expect(() => new Ctx().mount(workflowPlugin([countingWorkflow(), countingWorkflow()]))).toThrow(
      '工作流 "count" 重复注册',
    )
  })
})
