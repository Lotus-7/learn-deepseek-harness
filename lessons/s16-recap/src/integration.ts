import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import type { AssembleRuntime } from './assemble'
import type { LoggedEvent } from './log'

/**
 * 整合剧本与演示数据（index.ts 的演示与 recap.test.ts 的测试共用）：
 * 一轮对话串起 s06/s09/s10/s11/s12/s13 的能力面——技能加载、大文件读入
 * 并触发压缩、沙箱命令、后台 job 两段收取、子代理复核、落盘与 resume。
 * 全部确定性：数据由函数生成，模型响应由剧本回放。
 */

/** 演示数据目录（沙箱世界内）。 */
export const DATA_DIR = '/sandbox/data'

/** 商品名轮换表：中文密集——token 估算按 1 字 1 token，是触发压缩的主力。 */
const ITEMS = [
  '现烤出炉榴莲酥礼盒装六枚',
  '家庭装菠萝包袋装八个当日达',
  '流心蛋黄酥铁盒四枚装',
  '传统老婆饼纸盒六枚装',
] as const

/** 区域计划：12/10/8 的分布写死在数据生成里。 */
const REGION_PLAN = [
  ['华北', 12],
  ['华南', 10],
  ['华东', 8],
] as const

/**
 * 生成 sales.csv：30 行明细，金额一律 280（合计 30 × 280 = 8400）。
 * @returns 文件全文（含表头与结尾换行；wc -l 数出 31）。
 */
export function salesCsv(): string {
  const rows: string[] = ['date,region,item,amount']
  let index = 0
  for (const [region, count] of REGION_PLAN) {
    for (let i = 0; i < count; i++) {
      rows.push(`2026-08-${String((index % 7) + 1).padStart(2, '0')},${region},${ITEMS[index % ITEMS.length]},280`)
      index += 1
    }
  }
  return `${rows.join('\n')}\n`
}

/**
 * 生成 regions.csv：区域对照表（owner + 职责说明）。
 * @returns 文件全文（3 个区域，与 REGION_PLAN 一致）。
 */
export function regionsCsv(): string {
  const rows = [
    'region,owner,note',
    '华北,小七,负责华北区的大客户与渠道伙伴的日常对接以及每季度的联合复盘',
    '华南,阿九,负责华南区的新渠道开拓与每周现场巡店检查的记录归档',
    '华东,老周,负责华东区的电商平台运营与月度对账差异的追踪闭环',
  ]
  return `${rows.join('\n')}\n`
}

/** turn 1 的任务输入：需求书 + 自检数字（数字进 user 正文，压缩摘要才收得到）。 */
export const REQUEST =
  '本周核账任务：仓库 /sandbox/data 下有 sales.csv（销售明细）与 regions.csv（区域对照）。' +
  '步骤：先加载 csv 技能按其规程干活；把两份数据都读进来建立上下文；用命令行确认明细行数；' +
  '把复核工作委派给一个子代理独立做一遍；同时在后台挂一个汇总 job；两次收取 job 结果' +
  '（第一次看进度、第二次拿报告）；最后汇总答复。自检数字：订单 30 笔、金额合计 8400、' +
  '区域分布 12/10/8。背景：这是每周五的固定核账动作，所有结论必须引用核对过的数字，' +
  '不许凭印象报数；子代理结论与主结论不一致时，以命令行数出的行数为准。'

/**
 * turn 1 剧本：父代理的响应与子代理的响应共用同一个 mock（子代理继承父的
 * 模型实例），按调用次序排列——子代理的三条（c1/c2/回答）夹在 delegate
 * 请求与父的下一次请求之间。
 */
export const TURN1_SCRIPT: ModelResponse[] = [
  // —— 技能加载（s12）：目录 → 加载规程 ——
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'list_skills', {})] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'load_skill', { name: 'csv' })] },
    finishReason: 'tool_calls',
  },
  // —— 读入两份数据（s09 的 fs 面）：派生历史超阈值后，压缩在下一个步骤边界触发（s06）——
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('t3', 'read_file', { path: `${DATA_DIR}/sales.csv` })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('t4', 'read_file', { path: `${DATA_DIR}/regions.csv` })] },
    finishReason: 'tool_calls',
  },
  // —— 沙箱执行（s10）：wc 数行数（ask 审批 ①）——
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('t5', 'run_command', { command: 'wc', args: ['-l', `${DATA_DIR}/sales.csv`] })] },
    finishReason: 'tool_calls',
  },
  // —— 后台 job（s12）：登记即返回（ask 审批 ②）——
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('t6', 'start_job', { kind: 'summary-report', input: DATA_DIR })] },
    finishReason: 'tool_calls',
  },
  // —— 委派子代理（s11）：阻塞等复核结论（ask 审批 ③）；子代理消费接下来的 3 条响应 ——
  {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        toolCall('t7', 'delegate', {
          task: '复核：读 /sandbox/data/sales.csv，独立数出数据行数（不含表头）与金额合计，报告两个数字。',
        }),
      ],
    },
    finishReason: 'tool_calls',
  },
  // —— 子代理的私有循环：列目录 → 读明细 → 给结论（不进父日志，折叠成一对 tool/call+result）——
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'list_dir', { path: DATA_DIR })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('c2', 'read_file', { path: `${DATA_DIR}/sales.csv` })] },
    finishReason: 'tool_calls',
  },
  { message: { role: 'assistant', content: '复核完成：数据 30 行（不含表头），逐行金额相加合计 8400。' }, finishReason: 'stop' },
  // —— 两段收取（s12）：第一次 running（ask 审批 ④），第二次 done（命中会话记忆，不再问）——
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('t8', 'collect_job', { id: 'job-1' })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('t9', 'collect_job', { id: 'job-1' })] },
    finishReason: 'tool_calls',
  },
  // —— 最终回答：每个数字都有出处 ——
  {
    message: {
      role: 'assistant',
      content:
        '核账完成：wc 数出 31 行（表头 1 + 数据 30），与自检的 30 笔一致；子代理独立复核得 30 行、合计 8400，与主口径一致；' +
        '后台汇总报告确认 2 个数据文件、区域分布 12/10/8、金额合计 8400。全部数字均已核对。',
    },
    finishReason: 'stop',
  },
]

/** turn 2（重启后）的剧本：一问一答，回答引用重启前的历史。 */
export const RESUME_SCRIPT: ModelResponse[] = [
  {
    message: {
      role: 'assistant',
      content: '重启前的结论就在日志里：数据 30 笔、金额合计 8400，区域分布 12/10/8；汇总报告里的金额也是 8400。',
    },
    finishReason: 'stop',
  },
]

/** turn 2 的用户输入。 */
export const RESUME_REQUEST = '重启之后的第一问：上周核账的最终结论是什么？汇总报告里的金额是多少？'

/**
 * 取某个 callId 的 tool/result 输出（找不到即断言失败）。
 * @param events - 事件流。
 * @param callId - 调用 id。
 * @returns 该调用的模型可见结果文本。
 */
export function resultOf(events: readonly LoggedEvent[], callId: string): string {
  for (const event of events) {
    if (event.type === 'tool/result' && event.callId === callId) return event.output
  }
  throw new Error(`事件流里没有 callId=${callId} 的 tool/result——剧本与断言脱节`)
}

/**
 * 组装一次运行时资源：剧本模型 + 审批记录 + 会话目录。
 * @param script - mock 剧本。
 * @param approvals - 审批记录通道（ask 时 push）。
 * @param world - 执行世界（跨「重启」共享——同一台机器）。
 * @param sessionsDir - 会话目录（persistence 行的部署资源）。
 * @returns 可交给 assembleBundle 的运行时资源。
 */
export function runtimeOf(
  script: readonly ModelResponse[],
  approvals: string[],
  world: AssembleRuntime['world'],
  sessionsDir: string,
): AssembleRuntime & { model: ReturnType<typeof createMockModel> } {
  return {
    model: createMockModel([...script]),
    sessionsDir,
    world,
    askUser: async (question) => {
      approvals.push(`${question.tool} ← ${question.reason}`)
      return 'allow'
    },
  }
}
