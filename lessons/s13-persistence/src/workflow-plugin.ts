import type { Plugin } from './cordis'
import {
  WorkflowError,
  type JobDefinition,
  type JobSnapshot,
  type JobStatus,
  type WorkflowService,
} from './workflow-service'

/**
 * workflow 服务插件：job 注册表 + 状态机 + 事件驱动推进，贡献为 `workflows` 服务。
 *
 * dsh 对应两处：packages/workflow/workflow-worker-thread（引擎 provider——
 * 每 run 一个 worker 线程跑脚本、host/worker 结构化克隆协议、dispose 有
 * terminate 兜底）与 packages/jobs/jobs-local（进程内 job 注册表 provider）。
 * 教学版把「执行」折叠成**事件驱动的惰性推进**：
 *
 * - 每条 **tool/result** 事件落账（session/event 广播）推进一步所有活 job——
 *   「主对话每完成一件实事，后台工作流走一拍」。推进源选 tool/result 而不是
 *   全部事件：assistant/message 是叙述、tool/call 是意图，只有 tool/result
 *   是「一件实事完成了」——后台进度与主循环的实际工作量对齐，演示与测试
 *   因此完全确定（剧本里数 tool/result 就能数出 job 走到哪一步）。
 * - collect 时若未终态也推一步（模型主动等结果时的「再走一拍」）。
 *
 * 为什么监听 session/event 不算越界（emit 事件「只观察、不能改写」）：
 * 推进 job 不改写任何会话事实——它改变的是 job 注册表自己的状态，会话日志
 * 对此一无所知也无需知情；把会话事件流当时钟用，是教学版的取舍：真码的
 * 推进是真并行（worker 线程自跑，见 workflow-worker-thread 的
 * "prevents synchronous script work from blocking the host"），教学版用共享
 * 事件泵换掉真线程，换来零竞态与完全可测。
 *
 * 在途步骤不等待：advance 发起 iterator.next() 就返回（emit 监听器是同步
 * 循环，等待会卡住落账方）。步骤体在微任务内落定时（JobWorkflow 的契约），
 * 下一次快照读取看到的就是落定后的状态——演示与测试都依赖这一点。
 *
 * @param definitions - 装配选定的工作流定义清单（重复 kind 是装配错误，当场抛）。
 * @returns 可挂载的插件。
 */
export function workflowPlugin(definitions: readonly JobDefinition[]): Plugin {
  return {
    name: 'workflow',
    apply(ctx) {
      const registry = new Map<string, JobDefinition>()
      for (const definition of definitions) {
        if (registry.has(definition.kind)) {
          throw new Error(
            `工作流 "${definition.kind}" 重复注册（现有：${[...registry.keys()].join(', ')}）；重名通常是重复装配，请检查装配清单`,
          )
        }
        registry.set(definition.kind, definition)
      }

      /** 内部账本：快照字段 + start 时的输入 + 活着的生成器（终态后清引用）。 */
      interface InternalJob {
        id: string
        kind: string
        status: JobStatus
        progress: string[]
        input: string
        result?: string
        error?: string
        iterator?: AsyncGenerator<string, string, void>
        /** 在途的一步推进（见 advanceStart）：落定后清除。 */
        inFlight?: Promise<void>
      }
      const jobs = new Map<string, InternalJob>()
      let nextId = 1

      /** 只读快照：字段拷贝，progress 冻结成新数组（观察者拿不到内部状态）。 */
      const snapshotOf = (job: InternalJob): JobSnapshot => ({
        id: job.id,
        kind: job.kind,
        status: job.status,
        progress: Object.freeze([...job.progress]),
        ...(job.result !== undefined ? { result: job.result } : {}),
        ...(job.error !== undefined ? { error: job.error } : {}),
      })

      /**
       * 真正走一步：pending 先开工（创建生成器），随后走一次 next() 并落定。
       * 落定只发生在这一个地方——done / failed 是 first-wins 的终态。
       */
      const step = async (job: InternalJob): Promise<void> => {
        if (job.status === 'pending') {
          job.status = 'running'
          job.iterator = registry.get(job.kind)!.run(job.input)
        }
        try {
          const outcome = await job.iterator!.next()
          if (outcome.done) {
            // return 交出最终结果：终态只在这里（和下面的失败分支）落定。
            job.status = 'done'
            job.result = outcome.value
            job.iterator = undefined
          } else {
            job.progress.push(outcome.value)
          }
        } catch (error) {
          // 工作流体抛错：failed 是终态快照不是异常——collect 永远拿快照。
          job.status = 'failed'
          job.error = error instanceof Error ? error.message : String(error)
          job.iterator = undefined
        }
      }

      /**
       * 发起推进并返回「本步落定」的 Promise：
       * - 已终态：立即落定（no-op）；
       * - 已有在途推进：**等它而不是再叠一步**——tick 与 collect 并发时，
       *   「一次 collect 至多推进一拍」不被破坏（生成器的 next 虽然会排队串行，
       *   但叠加推进会让 collect 一次走两步，测试的确定性就没了）。
       * 调用方决定等不等：session/event 监听器 `void advance(job)`（推进语义
       * 见文件头注释），collect `await advance(job)`（快照反映推进后的状态）。
       */
      const advance = (job: InternalJob): Promise<void> => {
        if (job.status === 'done' || job.status === 'failed') return Promise.resolve()
        job.inFlight ??= step(job).finally(() => {
          job.inFlight = undefined
        })
        return job.inFlight
      }

      const service: WorkflowService = {
        start(kind, input = ''): JobSnapshot {
          if (!registry.has(kind)) {
            throw new WorkflowError(
              `没有叫 "${kind}" 的工作流（可用：${[...registry.keys()].join(', ') || '无'}）`,
              'WORKFLOW_KIND_UNKNOWN',
            )
          }
          const job: InternalJob = { id: `job-${nextId++}`, kind, status: 'pending', progress: [], input }
          jobs.set(job.id, job)
          return snapshotOf(job)
        },

        async collect(id: string): Promise<JobSnapshot> {
          const job = jobs.get(id)
          if (job === undefined) {
            throw new WorkflowError(
              `没有编号为 "${id}" 的后台 job（现存：${[...jobs.keys()].join(', ') || '无'}）`,
              'WORKFLOW_JOB_UNKNOWN',
            )
          }
          await advance(job)
          return snapshotOf(job)
        },

        snapshotOf(id: string): JobSnapshot {
          const job = jobs.get(id)
          if (job === undefined) {
            throw new WorkflowError(
              `没有编号为 "${id}" 的后台 job（现存：${[...jobs.keys()].join(', ') || '无'}）`,
              'WORKFLOW_JOB_UNKNOWN',
            )
          }
          return snapshotOf(job)
        },
      }
      ctx.service('workflows', service)

      // 推进源：主对话每落一条 tool/result（一件实事完成），全部活 job 各走一拍。
      // 监听器不等待在途步骤（文件头注释的推进语义）；读取 event 只为筛类型。
      ctx.on('session/event', ({ event }) => {
        if (event.type !== 'tool/result') return
        for (const job of jobs.values()) void advance(job)
      })
    },
  }
}
