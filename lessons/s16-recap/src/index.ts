import { BASE, FULL_PROFILE, layerOf, resolveBundle } from './bundles'
import { assembleBundle } from './assemble'
import { createSandboxWorld } from './world-sandbox'
import { renderTranscript } from './transcript'
import { SessionLog, type LoggedEvent } from './log'
import { makeScratchDir, scanFile } from './persistence'
import {
  DATA_DIR,
  REQUEST,
  RESUME_REQUEST,
  RESUME_SCRIPT,
  TURN1_SCRIPT,
  regionsCsv,
  resultOf,
  runtimeOf,
  salesCsv,
} from './integration'

// —— 收官演示：不再加新机制，把 16 课的能力面串进同一轮对话 ——
// s14 的 full profile 是底座；本课补进 BASE 的 persistence 行让落盘成为
// 底座行为（s14 时它是运行时装配位的特权），恢复真跑的 summary-report
// 工作流（s14 曾收成占位）。剧本与数据在 integration.ts（测试共用）。

// —— 序幕：装配——底座带持久化，full 只重述产品决策 ——
console.log('—— 序幕：装配——BASE 10 行（s16 补进 persistence 行），full 只重述权限规则 ——')
const resolved = resolveBundle(BASE, [layerOf(FULL_PROFILE)])
console.log(`  base 行表：${BASE.map((entry) => entry.id).join(' → ')}`)
console.log(`  full 覆盖：${FULL_PROFILE.overrides.map((override) => override.id).join('、')}（其余行与 base 同一对象）`)
console.log(`  名册 ${resolved.roster.length} 工具；压缩阈值 ${resolved.compaction.threshold}；审批默认 ${resolved.permission.defaultDecision}。`)

// —— 第一幕：整合剧本——一轮对话串起六个能力面 ——
console.log('\n—— 第一幕：整合剧本（full profile，一轮对话串起 s06/s09/s10/s11/s12/s13）——')
const approvals: string[] = []
const world = createSandboxWorld()
await world.writeFile(`${DATA_DIR}/sales.csv`, salesCsv())
await world.writeFile(`${DATA_DIR}/regions.csv`, regionsCsv())
const sessionsDir = makeScratchDir('s16-demo-')
const sessionPath = `${sessionsDir}/session.jsonl`

const runtime1 = runtimeOf(TURN1_SCRIPT, approvals, world, sessionsDir)
const ctx1 = assembleBundle(resolved, runtime1)
await ctx1.get('agent').run(REQUEST)
const events1: readonly LoggedEvent[] = ctx1.get('sessions').log.events

// 每个能力面的证据（演示同样不放过任何一个）。
if (!events1.some((event) => event.type === 'system/message' && event.content.includes('skill: csv'))) {
  throw new Error('技能加载应落 system/message 事件（s12）')
}
const compactionEvents = events1.filter((event) => event.type === 'session/compacted')
if (compactionEvents.length === 0) throw new Error('读入两份大文件后应在步骤边界触发压缩（s06）')
const wcOutput = resultOf(events1, 't5')
if (!wcOutput.includes('31')) throw new Error(`沙箱 wc 应数出 31 行，实际：${wcOutput}`)
const delegateOutput = resultOf(events1, 't7')
if (!delegateOutput.includes('子代理') || !delegateOutput.includes('8400')) {
  throw new Error('delegate 应折叠子代理结论（s11）')
}
const collect1 = resultOf(events1, 't8')
const collect2 = resultOf(events1, 't9')
if (!collect1.includes('running')) throw new Error('第一次 collect 应看到 running（s12）')
if (!collect2.includes('done') || !collect2.includes('8400')) throw new Error('第二次 collect 应拿到 done 报告（s12）')
if (approvals.length !== 4) {
  throw new Error(`full 应有 4 次 ask 审批（run_command/start_job/delegate/collect），实际 ${approvals.length}`)
}

console.log(`  用户任务：${REQUEST.slice(0, 40)}…（需求书 + 自检数字进 user 正文——数字才能进压缩摘要）`)
for (const line of renderTranscript(events1)) console.log(`  ${line}`)
const compacted = compactionEvents[0]!
if (compacted.type !== 'session/compacted') throw new Error('unreachable')
console.log(
  `  审批问答 ${approvals.length} 次：${approvals.map((line) => line.split(' ←')[0]).join('、')}（全部批准）；` +
    '第二次 collect_job 命中会话记忆（s04 的 remember），复用裁决不再问人。',
)
console.log(
  `  压缩检查点：估算 token ${compacted.tokensBefore} → ${compacted.tokensAfter}，被摘要替代 ${compacted.shadowedCount} 条头部事实；` +
    'csv 规程（system）不在被替代之列——规程豁免。',
)
console.log('  委派隔离：父日志里 delegate 只有一对 tool/call + tool/result；子的 3 步在它自己的私有日志。')
console.log('  job 两态：collect#1 → running（进度叙述）；collect#2 → done（汇总报告，金额 8400）。')
console.log(`  落盘：${sessionPath}（append 即 fsync，跑完即可打开看）。`)

// —— 第二幕：重启——新装配 resume 同一文件，模型记得上周的账 ——
console.log('\n—— 第二幕：进程重启——同一底座 resume 同一文件，turn 2 续聊（s13）——')
// 模拟重启：从此不再触碰 ctx1 / runtime1；世界与会话文件留在这台「机器」上。
const approvals2: string[] = []
const runtime2 = runtimeOf(RESUME_SCRIPT, approvals2, world, sessionsDir)
const ctx2 = assembleBundle(resolveBundle(BASE, [layerOf(FULL_PROFILE)]), runtime2)
const sessions2 = ctx2.get('sessions')
const turnBefore = sessions2.log.nextTurn()
const seqBefore = sessions2.log.events.length
if (turnBefore !== 2) throw new Error(`resume 后 turn 应从 2 续接，实际 ${turnBefore}`)
await ctx2.get('agent').run(RESUME_REQUEST)
const events2: readonly LoggedEvent[] = sessions2.log.events

// 记忆延续的硬证据：重启后第一次模型请求包含重启前的关键事实。
const firstRequest = runtime2.model.calls[0] ?? []
if (!firstRequest.some((message) => message.content?.includes('8400'))) {
  throw new Error('重启后第一次请求应含自检数字 8400——「模型看得见历史」被破坏')
}
if (!firstRequest.some((message) => message.content?.includes('核账'))) {
  throw new Error('重启后第一次请求应含重启前的任务叙述（压缩摘要保留了要点）')
}
const resumedAnswer = events2.findLast((event) => event.type === 'assistant/message' && event.message.content !== null)
if (resumedAnswer === undefined || resumedAnswer.type !== 'assistant/message') throw new Error('turn 2 应以回答收尾')
console.log(`  resume：重放 ${seqBefore} 条事件重建日志；turn 从 ${turnBefore} 续接，新事件 seq 从 ${seqBefore} 续接。`)
console.log('  请求检查：重启后第一次模型请求包含「核账」与「8400」——记忆来自日志，不来自剧本自觉。')
console.log(`  模型回答：${resumedAnswer.message.content}`)

// —— 收束：append-only 完整性——重放重建与逐事件一致 ——
console.log('\n—— 收束：全链路 append-only 完整性 ——')
const scanned = scanFile(sessionPath)
if (scanned.events.length !== events2.length) {
  throw new Error(`磁盘 ${scanned.events.length} 条 / 内存 ${events2.length} 条——落账即落盘被破坏`)
}
for (const [index, event] of scanned.events.entries()) {
  if (JSON.stringify(event) !== JSON.stringify(events2[index])) {
    throw new Error(`第 ${index} 条事件磁盘与内存不一致——append-only 链路有写丢或错序`)
  }
}
const replayed = SessionLog.replay(scanned.events)
const projected = replayed.deriveMessages()
const live = sessions2.log.deriveMessages()
if (JSON.stringify(projected) !== JSON.stringify(live)) {
  throw new Error('仅凭文件重放投影出的派生历史与活会话不一致——重放重建被破坏')
}
console.log(`  磁盘 ${scanned.events.length} 条事件逐条与内存一致（含压缩检查点与两个 turn 的全部事实）。`)
console.log(`  重放投影：仅凭文件重建的派生历史与活会话一致（${projected.length} 条消息，含 system 规程与 summary）。`)
console.log(
  [
    '',
    '收束：一轮对话里，技能规程经 system 段生效、两份大文件触发压缩、wc 在沙箱里数行、后台 job 与子代理并行推进、',
    '每条事实落账即落盘——重启之后，同一个 full profile 从同一份底座 resume，模型仍记得上周的账。',
    `会话文件在 ${sessionPath}——每行一个事件，seq 即行号减一头行。`,
  ].join('\n'),
)
