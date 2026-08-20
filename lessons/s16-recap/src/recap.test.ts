import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, FULL_PROFILE, layerOf, resolveBundle } from './bundles'
import { assembleBundle } from './assemble'
import { createSandboxWorld } from './world-sandbox'
import { SessionLog, type LoggedEvent } from './log'
import { makeScratchDir, removeScratchDir, scanFile } from './persistence'
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

/**
 * 整合剧本的端到端测试：full profile + BASE 的 persistence 行，一轮对话
 * 覆盖技能/压缩/沙箱/job/委派/落盘六个能力面，随后「重启」resume 续聊。
 * 每个能力面至少一条事件/状态断言；收束面断言 append-only 全链路
 * （磁盘逐事件一致 + 仅凭文件重放投影一致）。
 */

/** rig 状态：会话目录清理清单 + 每个测试独享的世界与目录。 */
const scratchDirs: string[] = []

/** 组装并预置世界：每个测试一个新沙箱 + 新目录（互不残留）。 */
async function freshWorld() {
  const world = createSandboxWorld()
  await world.writeFile(`${DATA_DIR}/sales.csv`, salesCsv())
  await world.writeFile(`${DATA_DIR}/regions.csv`, regionsCsv())
  const sessionsDir = makeScratchDir('s16-recap-')
  scratchDirs.push(sessionsDir)
  return { world, sessionsDir }
}

describe('整合剧本（full profile）：一轮对话覆盖六个能力面', () => {
  it('技能（s12）：加载落 system/message 事件，规程进派生历史', async () => {
    const { world, sessionsDir } = await freshWorld()
    const approvals: string[] = []
    const ctx = assembleBundle(
      resolveBundle(BASE, [layerOf(FULL_PROFILE)]),
      runtimeOf(TURN1_SCRIPT, approvals, world, sessionsDir),
    )
    await ctx.get('agent').run(REQUEST)
    const events: readonly LoggedEvent[] = ctx.get('sessions').log.events
    // 事件面：规程以 system/message 落账（s12 的注入事实）。
    expect(events.some((event) => event.type === 'system/message' && event.content.includes('skill: csv'))).toBe(true)
    // 投影面：规程在派生历史里持续生效（role system）。
    expect(ctx.get('sessions').log.deriveMessages().some((message) => message.role === 'system')).toBe(true)
    // 工具面：目录与加载两次往返都有结果。
    expect(resultOf(events, 't1')).toContain('csv')
    expect(resultOf(events, 't2')).toContain('已加载')
    removeScratchDir(scratchDirs.pop()!)
  })

  it('压缩（s06）：大文件读入后在步骤边界触发，规程豁免、数字进摘要', async () => {
    const { world, sessionsDir } = await freshWorld()
    const approvals: string[] = []
    const ctx = assembleBundle(
      resolveBundle(BASE, [layerOf(FULL_PROFILE)]),
      runtimeOf(TURN1_SCRIPT, approvals, world, sessionsDir),
    )
    await ctx.get('agent').run(REQUEST)
    const events: readonly LoggedEvent[] = ctx.get('sessions').log.events
    const compacted = events.find((event) => event.type === 'session/compacted')
    expect(compacted).toBeDefined()
    if (compacted === undefined || compacted.type !== 'session/compacted') throw new Error('unreachable')
    expect(compacted.shadowedCount).toBeGreaterThan(0)
    // 摘要保留了 user 正文里的自检数字（deterministicSummarize 的数字事实）。
    expect(compacted.summary).toContain('8400')
    // 压缩后的派生历史仍有 system 规程（s12 的规程豁免）与 summary。
    const derived = ctx.get('sessions').log.deriveMessages()
    expect(derived.some((message) => message.role === 'system')).toBe(true)
    expect(derived.some((message) => message.content?.includes('compacted-summary'))).toBe(true)
    removeScratchDir(scratchDirs.pop()!)
  })

  it('沙箱（s10）：wc 在沙箱世界执行，数出 31 行（表头 1 + 数据 30）', async () => {
    const { world, sessionsDir } = await freshWorld()
    const approvals: string[] = []
    const ctx = assembleBundle(
      resolveBundle(BASE, [layerOf(FULL_PROFILE)]),
      runtimeOf(TURN1_SCRIPT, approvals, world, sessionsDir),
    )
    await ctx.get('agent').run(REQUEST)
    const events: readonly LoggedEvent[] = ctx.get('sessions').log.events
    expect(resultOf(events, 't5')).toContain('31')
    removeScratchDir(scratchDirs.pop()!)
  })

  it('后台 job（s12）：登记即返回；第一次 collect 看 running，第二次拿 done 报告', async () => {
    const { world, sessionsDir } = await freshWorld()
    const approvals: string[] = []
    const ctx = assembleBundle(
      resolveBundle(BASE, [layerOf(FULL_PROFILE)]),
      runtimeOf(TURN1_SCRIPT, approvals, world, sessionsDir),
    )
    await ctx.get('agent').run(REQUEST)
    const events: readonly LoggedEvent[] = ctx.get('sessions').log.events
    expect(resultOf(events, 't6')).toContain('job-1')
    expect(resultOf(events, 't8')).toContain('running')
    const report = resultOf(events, 't9')
    expect(report).toContain('done')
    expect(report).toContain('8400')
    removeScratchDir(scratchDirs.pop()!)
  })

  it('委派（s11）：子代理结论折叠回父，父日志只有一对 delegate 事件', async () => {
    const { world, sessionsDir } = await freshWorld()
    const approvals: string[] = []
    const ctx = assembleBundle(
      resolveBundle(BASE, [layerOf(FULL_PROFILE)]),
      runtimeOf(TURN1_SCRIPT, approvals, world, sessionsDir),
    )
    await ctx.get('agent').run(REQUEST)
    const events: readonly LoggedEvent[] = ctx.get('sessions').log.events
    const outcome = resultOf(events, 't7')
    expect(outcome).toContain('子代理')
    expect(outcome).toContain('已完成')
    expect(outcome).toContain('8400')
    // 隔离：父日志里 delegate 的 tool/call 恰一条，子的 c1/c2 调用不进父日志。
    expect(events.filter((event) => event.type === 'tool/call' && event.name === 'delegate')).toHaveLength(1)
    expect(events.some((event) => event.type === 'tool/call' && event.callId === 'c1')).toBe(false)
    expect(events.some((event) => event.type === 'tool/call' && event.callId === 'c2')).toBe(false)
    removeScratchDir(scratchDirs.pop()!)
  })

  it('审批（s04/s14）：四个危险面工具各问一次；第二次 collect 命中会话记忆', async () => {
    const { world, sessionsDir } = await freshWorld()
    const approvals: string[] = []
    const ctx = assembleBundle(
      resolveBundle(BASE, [layerOf(FULL_PROFILE)]),
      runtimeOf(TURN1_SCRIPT, approvals, world, sessionsDir),
    )
    await ctx.get('agent').run(REQUEST)
    // full 的 ask 面：run_command / start_job / delegate / collect_job 各一次；
    // 第二次 collect_job 复用会话记忆（remember: true），不再问人（s04）。
    expect(approvals.map((line) => line.split(' ←')[0])).toEqual([
      'run_command',
      'start_job',
      'delegate',
      'collect_job',
    ])
    removeScratchDir(scratchDirs.pop()!)
  })
})

describe('resume（s13）：重启后记忆延续', () => {
  it('第二次装配同一 sessionsDir 自动 resume：turn/seq 续接，请求含重启前事实', async () => {
    const { world, sessionsDir } = await freshWorld()
    const approvals1: string[] = []
    const ctx1 = assembleBundle(
      resolveBundle(BASE, [layerOf(FULL_PROFILE)]),
      runtimeOf(TURN1_SCRIPT, approvals1, world, sessionsDir),
    )
    await ctx1.get('agent').run(REQUEST)
    const events1: readonly LoggedEvent[] = ctx1.get('sessions').log.events

    // 重启：不再触碰 ctx1；新装配发现 session.jsonl 已存在 → resume 为种子。
    const approvals2: string[] = []
    const runtime2 = runtimeOf(RESUME_SCRIPT, approvals2, world, sessionsDir)
    const ctx2 = assembleBundle(resolveBundle(BASE, [layerOf(FULL_PROFILE)]), runtime2)
    const sessions2 = ctx2.get('sessions')
    expect(sessions2.log.nextTurn()).toBe(2)
    expect(sessions2.log.events).toHaveLength(events1.length)
    await ctx2.get('agent').run(RESUME_REQUEST)

    // 记忆延续的硬证据：重启后第一次模型请求看得见重启前的关键事实。
    const firstRequest = runtime2.model.calls[0] ?? []
    expect(firstRequest.some((message) => message.content?.includes('8400'))).toBe(true)
    expect(firstRequest.some((message) => message.content?.includes('核账'))).toBe(true)
    // turn 2 的事件接在种子之后，seq 连续不重置。
    const events2: readonly LoggedEvent[] = sessions2.log.events
    expect(events2[events1.length]?.seq).toBe(events1.length)
    removeScratchDir(scratchDirs.pop()!)
  })
})

describe('append-only 全链路（s03/s13）：重放重建一致', () => {
  it('磁盘逐事件与内存一致；仅凭文件重放投影出同样的派生历史；一事件一行', async () => {
    const { world, sessionsDir } = await freshWorld()
    const approvals1: string[] = []
    const ctx1 = assembleBundle(
      resolveBundle(BASE, [layerOf(FULL_PROFILE)]),
      runtimeOf(TURN1_SCRIPT, approvals1, world, sessionsDir),
    )
    await ctx1.get('agent').run(REQUEST)
    const approvals2: string[] = []
    const ctx2 = assembleBundle(
      resolveBundle(BASE, [layerOf(FULL_PROFILE)]),
      runtimeOf(RESUME_SCRIPT, approvals2, world, sessionsDir),
    )
    await ctx2.get('agent').run(RESUME_REQUEST)
    const events2: readonly LoggedEvent[] = ctx2.get('sessions').log.events

    // ① 落账即落盘：文件扫描出的每条事件与内存日志逐 JSON 相等。
    const path = join(sessionsDir, 'session.jsonl')
    const scanned = scanFile(path)
    expect(scanned.events).toHaveLength(events2.length)
    for (const [index, event] of scanned.events.entries()) {
      expect(JSON.stringify(event)).toBe(JSON.stringify(events2[index]))
    }
    // ② 重放重建：仅凭文件 replay 出的日志，投影与活会话一致（含压缩视图）。
    const replayed = SessionLog.replay(scanned.events)
    expect(replayed.deriveMessages()).toEqual(ctx2.get('sessions').log.deriveMessages())
    // ③ 磁盘形态：头行 + 每事件恰一行（append-only 的物理面）。
    const lines = readFileSync(path, 'utf8').split('\n')
    expect(lines).toHaveLength(scanned.events.length + 2) // 头行 + N 事件 + 结尾空串
    removeScratchDir(scratchDirs.pop()!)
  })
})
