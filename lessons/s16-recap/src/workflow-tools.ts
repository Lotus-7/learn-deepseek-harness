import type { Ctx } from './cordis'
import { defineTool, type Tool } from './tools'
import { WorkflowError, type WorkflowErrorCode, type JobSnapshot } from './workflow-service'

/**
 * 后台工作流的模型面 Consumer：start_job / collect_job。
 *
 * **start 与 collect 为什么是两个工具**：start 登记后立即返回（工具结果只是
 * job id 与登记事实），主循环拿回控制权继续干活；collect 随时来取快照——
 * 未完成时拿到的是进度（模型看到「还在跑」就先干别的），终态时拿到结果。
 * 一个工具做不到这件事：阻塞等完就是 s11 的 delegate（前台委派），不等完
 * 就没法交付结果。分离后「慢任务」与「主任务」在时间上重叠，代价只是模型
 * 多一次 collect 往返。
 * dsh 对照（真码现状）：tool-workflow 的 `workflow` 工具前台等待整个脚本
 * （packages/workflow/tool-workflow/README.md 明说 "there is no background
 * start/poll API"）；后台收集的现役真码是 jobs 家族的 job_output / job_list /
 * job_kill（packages/jobs/tool-jobs/src/index.ts）——start/collect 分离的
 * 语义在真仓由「长工具把工作登记进 ctx.jobs、模型经 job_* 工具收集」达成
 * （docs/architecture.md 的 Where new behavior goes："Add background work |
 * register on `ctx.jobs`; `job_*` tools collect or stop it"）。
 *
 * 回喂文本的取舍：start 的结果带全部可用 kind（模型的第一次 start 若拼错名，
 * 错误与名册一起回到它眼前）；collect 的结果按状态渲染三态——running 给
 * progress 与「稍后再来」、done 给 result、failed 给 error（收集失败本身不是
 * 工具错误：取回「失败」这个事实是 collect 的成功）。
 */
const REMEDIES: Partial<Record<WorkflowErrorCode, string>> = {
  WORKFLOW_KIND_UNKNOWN: '请检查 kind 拼写；可用工作流见错误信息中的名册',
  WORKFLOW_JOB_UNKNOWN: '请检查 job 编号（start_job 返回的 id）；现存编号见错误信息',
}

/**
 * 给契约内失败补模型面的补救语（不改 seam 的原始信息）。
 * @param error - 工具体里抛出的任意值。
 * @returns 带补救语的新 WorkflowError；无补救语或非 WorkflowError 的原样返回。
 */
function remediate(error: unknown): unknown {
  if (!(error instanceof WorkflowError)) return error
  const remedy = REMEDIES[error.code]
  if (remedy === undefined) return error
  return new WorkflowError(`${error.message} —— ${remedy}`, error.code)
}

/** 把快照渲染成回喂文本：三态各一段，模型据此决定「再等」还是「引用结果」。 */
function render(snapshot: JobSnapshot): string {
  const head = `job ${snapshot.id}（${snapshot.kind}）`
  if (snapshot.status === 'pending') return `${head}：pending（尚未开工，主对话下一件实事就会推进它）。`
  if (snapshot.status === 'running') {
    const lines = snapshot.progress.length > 0 ? snapshot.progress.map((line) => `- ${line}`) : ['-（尚未产出第一步）']
    return [`${head}：running（后台进行中，本次 collect 不阻塞）——已完成的步骤：`, ...lines].join('\n')
  }
  if (snapshot.status === 'done') {
    return [`${head}：done——最终结果：`, snapshot.result ?? ''].join('\n')
  }
  return `${head}：failed——后台步骤抛错：${snapshot.error ?? ''}`
}

/**
 * 组装工作流工具：start_job + collect_job。
 * @param ctx - 目标装配的容器：执行时经它解析 `workflows` 服务。
 * @returns 两个 defineTool 产物。
 */
export function workflowTools(ctx: Ctx): Tool[] {
  const startJobTool = defineTool({
    name: 'start_job',
    description:
      '在后台登记一个工作流 job 并立即返回其编号（不等待完成）：主对话继续干活，job 随每件完成的实事推进一步；' +
      '随后用 collect_job 取进度或结果。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '工作流名（装配时注册的种类）' },
        input: { type: 'string', description: '交给工作流的输入文本（比如要处理的目录或主题）' },
      },
      required: ['kind'],
    },
    execute: async (args) => {
      try {
        const snapshot = ctx.get('workflows').start(String(args.kind), args.input === undefined ? '' : String(args.input))
        return `已登记后台 job ${snapshot.id}（${snapshot.kind}）：状态 pending，主对话每完成一件工具实事它就推进一步；用 collect_job({ id: "${snapshot.id}" }) 取进度或结果。`
      } catch (error) {
        throw remediate(error)
      }
    },
  })

  const collectJobTool = defineTool({
    name: 'collect_job',
    description:
      '收集一个后台 job 的当前快照（不阻塞）：running 时返回已完成的步骤（稍后再来），done 时返回最终结果，failed 时返回失败原因；每次 collect 顺手推进一步。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'start_job 返回的 job 编号' },
      },
      required: ['id'],
    },
    execute: async (args) => {
      try {
        return render(await ctx.get('workflows').collect(String(args.id)))
      } catch (error) {
        throw remediate(error)
      }
    },
  })

  return [startJobTool, collectJobTool]
}
