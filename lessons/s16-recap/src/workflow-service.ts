/**
 * 后台工作流能力的 Service Definition：Job 词汇、状态机、错误分类与服务契约。
 *
 * 本模块只有词汇（沿四个 seam 的立场）。三个设计决定写在词汇里：
 *
 * 1. **工作流是可分步推进的生成器**（{@link JobWorkflow}）：`yield` 叙述进度、
 *    `return` 交出最终结果——「后台工作流」的教学形态是一串可挂起的步骤，
 *    推进权在引擎（workflow-plugin.ts），工作流体自己永远不抢跑。
 *    dsh 对照：真仓的工作流体是模型写的 JavaScript 脚本，在 worker 线程的
 *    vm 上下文里整段执行（packages/workflow/workflow-worker-thread/src/index.ts：
 *    "The thread prevents synchronous script work from blocking the host"），
 *    hooks 是 agent()/parallel()/pipeline()；教学版把「编排」收窄成
 *    「分步生成器」，把「真线程」收窄成「事件驱动推进」（见插件注释）。
 * 2. **start 与 collect 分离**：start 只登记（pending），立即返回 id；collect
 *    取一次快照、顺手推一步——**任何时刻都不阻塞**。为什么分离：后台工作流
 *    的价值就是主循环不被长任务占住（s11 的 delegate 是阻塞委派，适合「结论
 *    依赖子任务」的强依赖；后台 job 适合「结果晚点才有也不碍事」的弱依赖，
 *    比如边统计边等汇总报告）。dsh 现状恰好是反例参照：tool-workflow 的
 *    `workflow` 工具前台等待整个脚本结束（packages/workflow/tool-workflow/
 *    README.md："The parent turn blocks until the whole workflow settles —
 *    there is no background start/poll API"）；教学版的 start/collect 是真仓
 *    里明示 deferred 的方向，后台收集的现役真码在 jobs 家族
 *    （packages/jobs：ctx.jobs + job_output/job_list/job_kill 工具）。
 * 3. **结果从状态机读，不从 Promise 读**：JobSnapshot 是纯数据（id/kind/
 *    status/progress/result/error），终态只落一次（first-wins）。dsh 对照：
 *    WorkflowRun.result 是永不 reject 的 Promise + WorkflowResult 携带
 *    stopReason（packages/workflow/workflow/src/types.ts：completed/cancelled/
 *    error）；jobs 家族同样 "Settlement is first-wins: one terminal record"
 *    （packages/jobs/jobs/src/index.ts）。教学版没有并发竞态，快照即账本。
 */

/**
 * 工作流/job 的失败分类——契约的一部分（沿各 seam 的立场）。
 * dsh 对照：WorkflowError 携 WorkflowErrorCode（SCRIPT_PARSE / AGENT_CAP /
 * CANCELLED…，packages/workflow/workflow/src/index.ts）；教学版只有两条
 * 入口校验码——**job 体的失败不是错误码**，它落进 JobSnapshot.error
 * （failed 是终态快照，不是异常：调用方拿到的永远是快照）。
 */
export type WorkflowErrorCode =
  /** 注册表里没有这个 kind 的工作流定义。 */
  | 'WORKFLOW_KIND_UNKNOWN'
  /** collect 的 id 不属于任何 job（列出现存的）。 */
  | 'WORKFLOW_JOB_UNKNOWN'

/**
 * 类型化的工作流错误：message 面向人（进入模型可见的回喂文本），code 面向程序。
 */
export class WorkflowError extends Error {
  /** 稳定失败码：见 {@link WorkflowErrorCode}。 */
  readonly code: WorkflowErrorCode

  constructor(message: string, code: WorkflowErrorCode) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
  }
}

/**
 * 后台工作流的状态机：pending → running →（done | failed）。
 * - pending：已登记未开工（start 返回时就是它——「立即继续」的保证）；
 * - running：开工未收尾（progress 叙述已走完的步骤）；
 * - done：正常收尾（result 携带最终结果）；
 * - failed：某步抛错（error 携带错误文本）——终态，与 done 同级。
 * dsh 对照：WorkflowStopReason 的 completed/cancelled/error
 * （packages/workflow/workflow/src/types.ts）；jobs 家族的 settlement
 * 同样 first-wins 且终态唯一。教学版没有取消通道（没有 cancel），留两支终态。
 */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

/**
 * 一个 job 的纯数据快照：观察与回喂的全部事实。终态字段只在对应终态出现
 * （done 才有 result、failed 才有 error）——快照即账本，不需要回读 Promise。
 * dsh 对照：WorkflowResult（{value, stopReason, error?, agentsStarted}）+
 * workflow/log 事件的叙述行（packages/workflow/workflow/src/index.ts）。
 */
export interface JobSnapshot {
  /** 会话内 job 编号（job-1、job-2…）。 */
  readonly id: string
  /** 工作流定义名（start 时点名、注册表据此取定义）。 */
  readonly kind: string
  /** 当前状态（见 {@link JobStatus}）。 */
  readonly status: JobStatus
  /** 已完成步骤的叙述（yield 过的进度行，按序）。 */
  readonly progress: readonly string[]
  /** 最终结果：仅 done 出现。 */
  readonly result?: string
  /** 失败文本：仅 failed 出现。 */
  readonly error?: string
}

/**
 * 工作流体：分步生成器。`yield` 一行进度叙述（进入 progress），`return`
 * 交出最终结果（成为 done 的 result）；任意一步 throw 落成 failed。
 * 约束：**步骤体应当在微任务内落定**——教学版推进器不等待在途步骤
 * （见 workflow-plugin.ts 的推进语义），长步骤会让快照滞后一步。
 * dsh 的 hooks 对照：agent()/pipeline()/parallel() 是编排原语（真仓脚本能
 * 自己并发子代理）；教学版的生成器是顺序步骤，并发留给真码导读。
 * @param input - start 时携带的输入文本（如「给哪个目录出报告」）。
 */
export type JobWorkflow = (input: string) => AsyncGenerator<string, string, void>

/**
 * 一个工作流定义：注册表的一项。dsh 对照：真仓没有静态「工作流定义注册表」
 * ——每个 run 自带 meta（name/description）与脚本体（WorkflowStartRequest，
 * packages/workflow/workflow/src/runtime-types.ts），引擎按 run 执行；
 * jobs 家族才有跨 run 的 kind 注册（JobKindMap，packages/jobs/jobs/src/
 * index.ts）。教学版选静态注册表：演示与测试要确定地知道有哪些工作流。
 */
export interface JobDefinition {
  /** 工作流名（start_job 的 kind 参数按它取定义）。 */
  readonly kind: string
  /** 一行简介（给模型的路由依据）。 */
  readonly description: string
  /** 工作流体工厂：每次 start 调用一次，产出该 run 的生成器。 */
  readonly run: JobWorkflow
}

/**
 * `workflows` 服务的公开面：登记、收集、观察。
 * start/collect 两步就是 Consumer 工具（start_job / collect_job）的服务面；
 * snapshotOf 是不推进的观察口（演示与测试用——快照不因为有观察者而前进）。
 */
export interface WorkflowService {
  /**
   * 登记一个后台 job：创建 pending 快照并返回——**不推进、不执行任何步骤**，
   * 「立即继续」由此保证。
   * @param kind - 工作流定义名。
   * @param input - 交给工作流体的输入文本（缺省空串）。
   * @returns 新 job 的快照（status 恒为 pending）。
   * @throws WorkflowError WORKFLOW_KIND_UNKNOWN 名字不在注册表。
   */
  start(kind: string, input?: string): JobSnapshot
  /**
   * 收集一个 job：若未到终态就推进一步（pending 先开工），然后返回快照——
   * **永不阻塞**：未完成时快照是 running + progress（调用方稍后再来），
   * 终态时快照携带 result / error。终态后再 collect 幂等返回同一快照。
   * @param id - start 返回的 job 编号。
   * @returns 该 job 推进后的快照。
   * @throws WorkflowError WORKFLOW_JOB_UNKNOWN 没有这个编号的 job。
   */
  collect(id: string): Promise<JobSnapshot>
  /**
   * 观察一个 job 的当前快照（不推进）。
   * @param id - job 编号。
   * @returns 当前快照。
   * @throws WorkflowError WORKFLOW_JOB_UNKNOWN 没有这个编号的 job。
   */
  snapshotOf(id: string): JobSnapshot
}

// 服务目录扩展：给迷你 ServiceMap 加 'workflows' 键。键与类型归 Definition
// 所有；workflow-plugin.ts 贡献实例，Consumer（workflow-tools.ts）按键消费。
declare module './cordis.js' {
  interface ServiceMap {
    /** 后台工作流能力：登记 + 收集 + 观察（由 workflow-plugin 贡献）。 */
    workflows: WorkflowService
  }
}
