import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import {
  BASE,
  FULL_PROFILE,
  SAFE_PROFILE,
  layerOf,
  resolveBundle,
  type Layer,
  type Override,
  type ResolvedBundle,
} from './bundles'
import { assembleBundle, type AssembleRuntime } from './assemble'
import { createSandboxWorld } from './world-sandbox'
import { renderTranscript } from './transcript'
import type { LoggedEvent } from './log'

// —— s13 的全部能力原样在场（复制前进）；本课不再手写 assemble：
// 装配数据进了 bundles.ts（base / profile / patch 三层纯数据），
// 装配代码进了 assemble.ts（resolve 校验 → 按序挂载）。
// 演示四幕：装配对比 → 同一请求在 full 下（写/跑经 ask 批准）→
// 同一请求在 safe 下（写被 deny 回喂、模型改走只读路径）→
// 一行 patch 解锁 write_file，结局翻转。

/** 两个 profile 跑的是同一句话——产品差异全部来自装配，不来自请求。 */
const REQUEST = '把暗号「榴莲酥」写进 /sandbox/notes.md，然后用命令确认它在了。'

/** full 的剧本：写 → 跑 cat 确认 → 收尾。 */
const FULL_SCRIPT: ModelResponse[] = [
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('f1', 'write_file', { path: '/sandbox/notes.md', content: '暗号：榴莲酥' })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('f2', 'run_command', { command: 'cat', args: ['/sandbox/notes.md'] })] },
    finishReason: 'tool_calls',
  },
  { message: { role: 'assistant', content: '已写入并确认：cat 读回 /sandbox/notes.md，内容就是「暗号：榴莲酥」。' }, finishReason: 'stop' },
]

/** safe 的剧本：写被 deny → 改走 list_dir 只读确认 → 收尾。 */
const SAFE_SCRIPT: ModelResponse[] = [
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('s1', 'write_file', { path: '/sandbox/notes.md', content: '暗号：榴莲酥' })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('s2', 'list_dir', { path: '/sandbox' })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: 'write_file 被策略拒绝（本部署只读）。我改用 list_dir 确认了现状：/sandbox 里只有 README.md，没有 notes.md——我没有做任何修改。' },
    finishReason: 'stop',
  },
]

/** safe + patch 的剧本：写这次被批准 → 跑 cat 仍被拒 → list_dir 确认 → 收尾。 */
const PATCHED_SCRIPT: ModelResponse[] = [
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('p1', 'write_file', { path: '/sandbox/notes.md', content: '暗号：榴莲酥' })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('p2', 'run_command', { command: 'cat', args: ['/sandbox/notes.md'] })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('p3', 'list_dir', { path: '/sandbox' })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: 'write_file 这次经用户批准写入完成；run_command 仍被策略拒绝，我改用 list_dir 确认 notes.md 已在场。' },
    finishReason: 'stop',
  },
]

/**
 * 第四幕的一行 patch：给 safe 解锁 write_file（deny → ask）。
 * 覆盖必须**整行重述**（dsh 语义："A patch replaces whole row configs —
 * profile overrides must restate every field a row keeps"）：run_command、
 * delete_file 的 deny 与默认 deny 都要照抄——patch 换掉的是整行，漏写的
 * 字段不会从下层「继承」回来。这正是 dsh 不做深合并的理由：一行配置的
 * 最终值只看一层，可推理、可 dump。
 */
const UNLOCK_WRITE_PATCH: Override = {
  id: 'permission',
  plugin: 'permission',
  rules: {
    echo: 'allow',
    add: 'allow',
    read_file: 'allow',
    list_dir: 'allow',
    search_logs: 'allow',
    fetch_stats: 'allow',
    cached_stats: 'allow',
    slow_scan: 'allow',
    list_skills: 'allow',
    load_skill: 'allow',
    write_file: 'ask',
    run_command: 'deny',
    delete_file: 'deny',
  },
  defaultDecision: 'deny',
  remember: false,
}

/** 第四幕的层：patch 压在 profile 之上（对应 dsh 的 --patch overlay）。 */
const UNLOCK_LAYER: Layer = { name: 'patch/unlock-write', overrides: [UNLOCK_WRITE_PATCH] }

/**
 * 跑一个产品：resolve + assemble + 一个 turn。
 * @param layers - profile 层与 patch 层（依序）。
 * @param script - mock 剧本。
 * @param approvals - 审批记录通道（ask 时 push；deny 不经过它）。
 * @param seedFiles - 预置进世界的内容（宿主直接写，不走模型）。
 * @returns 容器、事件流、审批记录——断言与打印用。
 */
async function runProduct(
  layers: readonly Layer[],
  script: readonly ModelResponse[],
  approvals: string[],
  seedFiles: Readonly<Record<string, string>> = {},
): Promise<{ events: readonly LoggedEvent[] }> {
  const resolved = resolveBundle(BASE, layers)
  const world = createSandboxWorld()
  for (const [path, content] of Object.entries(seedFiles)) await world.writeFile(path, content)
  const runtime: AssembleRuntime = {
    model: createMockModel([...script]),
    world,
    askUser: async (question) => {
      approvals.push(`${question.tool} ← ${question.reason}`)
      return 'allow'
    },
  }
  const ctx = assembleBundle(resolved, runtime)
  await ctx.get('agent').run(REQUEST)
  return { events: ctx.get('sessions').log.events }
}

/** 取某个 callId 的 tool/result 输出（找不到即断言失败）。 */
function resultOf(events: readonly LoggedEvent[], callId: string): string {
  for (const event of events) {
    if (event.type === 'tool/result' && event.callId === callId) return event.output
  }
  throw new Error(`事件流里没有 callId=${callId} 的 tool/result——剧本与断言脱节`)
}

/** 名单里每个工具的最终裁决描述（rules 表的渲染）。 */
function describeRules(rules: Readonly<Record<string, string>>): string {
  const grouped = new Map<string, string[]>()
  for (const [tool, decision] of Object.entries(rules)) {
    const list = grouped.get(decision) ?? []
    list.push(tool)
    grouped.set(decision, list)
  }
  return [...grouped.entries()].map(([decision, tools]) => `${decision}（${tools.length}）`).join('、')
}

/** 摘要打印一行：名册规模、危险面裁决、压缩阈值。 */
function summaryLine(name: string, resolved: ResolvedBundle): string {
  return (
    `${name}：名册 ${resolved.roster.length} 工具；` +
    `规则 ${describeRules(resolved.permission.rules)}，默认 ${resolved.permission.defaultDecision}；` +
    `压缩阈值 ${resolved.compaction.threshold}`
  )
}

// —— 第一幕：装配——同一底座，两个产品 ——
console.log('—— 第一幕：装配——同一底座（BASE 9 行），两个 profile，两份产品数据 ——')
console.log(`  base 行表：${BASE.map((entry) => entry.id).join(' → ')}`)
const fullResolved = resolveBundle(BASE, [layerOf(FULL_PROFILE)])
const safeResolved = resolveBundle(BASE, [layerOf(SAFE_PROFILE)])
console.log(`  ${summaryLine('full', fullResolved)}`)
console.log(`  ${summaryLine('safe', safeResolved)}`)
const cutTools = fullResolved.roster.filter((name) => !safeResolved.roster.includes(name))
console.log(`  safe 砍出模型面的：${cutTools.join('、')}（schema 都不给）；留在名册但 deny 的：write_file、run_command、delete_file。`)
// 结构断言：两个 profile 都未覆盖的行是 base 的同一对象——profile 没有分叉代码，
// 只换了几行数据（full 换了 permission；safe 换了 tools / permission / compaction）。
for (const id of ['model', 'world', 'subagent', 'skill', 'workflow', 'loop'] as const) {
  const inFull = fullResolved.entries.find((entry) => entry.id === id)
  const inSafe = safeResolved.entries.find((entry) => entry.id === id)
  if (inFull !== inSafe) throw new Error(`两个 profile 的 "${id}" 行应是 base 的同一对象——层叠覆盖不得复制未覆盖的行`)
}
// 行为前置：两个 profile 装配出的插件列表一致——同一批插件，两个产品。
const silentWorld = createSandboxWorld()
const fullCtxPlugins = assembleBundle(fullResolved, { model: createMockModel([]), world: silentWorld }).plugins
const safeCtxPlugins = assembleBundle(safeResolved, { model: createMockModel([]), world: silentWorld }).plugins
if (fullCtxPlugins.join() !== safeCtxPlugins.join()) {
  throw new Error(`两个 profile 的插件列表应一致（同批插件组装不同产品），实际：${fullCtxPlugins.join()} vs ${safeCtxPlugins.join()}`)
}
console.log(`  插件列表一致（${fullCtxPlugins.join('、')}）——同一批插件，两个产品。`)

// —— 第二幕：同一请求 · full——写/跑经 ask 批准通过 ——
console.log('\n—— 第二幕：同一请求 · full profile——写与跑命令都先问人，批准后通过 ——')
const fullApprovals: string[] = []
const fullRun = await runProduct([layerOf(FULL_PROFILE)], FULL_SCRIPT, fullApprovals)
if (fullApprovals.length !== 2) throw new Error(`full 应有两次 ask 审批（write_file、run_command），实际 ${fullApprovals.length}`)
if (resultOf(fullRun.events, 'f1').includes('权限拒绝：')) throw new Error('full 的 write_file 应被批准执行，不应被拒')
console.log(`  审批问答 ${fullApprovals.length} 次：${fullApprovals.map((line) => line.split(' ←')[0]).join('、')}（两次都批准）。`)
console.log(`  write_file → ${resultOf(fullRun.events, 'f1')}`)
console.log(`  run_command → ${resultOf(fullRun.events, 'f2').split('\n').join(' ｜ ')}`)
for (const line of renderTranscript(fullRun.events)) console.log(`  ${line}`)

// —— 第三幕:同一请求 · safe——写被 deny 回喂,模型改走只读路径 ——
console.log('\n—— 第三幕：同一请求 · safe profile——写被 deny 回喂，模型改走只读路径 ——')
const safeApprovals: string[] = []
const safeRun = await runProduct([layerOf(SAFE_PROFILE)], SAFE_SCRIPT, safeApprovals, {
  '/sandbox/README.md': '本部署为只读分析环境。',
})
if (safeApprovals.length !== 0) throw new Error(`safe 不应触发任何审批（危险面全 deny），实际 ${safeApprovals.length} 次`)
const safeWrite = resultOf(safeRun.events, 's1')
if (!safeWrite.includes('权限拒绝：')) throw new Error(`safe 的 write_file 应被策略拒绝回喂，实际:${safeWrite}`)
if (!resultOf(safeRun.events, 's2').includes('README.md')) throw new Error('safe 的改道 list_dir 应看到预置的 README.md')
console.log(`  write_file → ${safeWrite}`)
console.log(`  list_dir  → ${resultOf(safeRun.events, 's2').replace('\n', ' ｜ ')}（改走只读路径，确认现状）`)
const safeAnswer = safeRun.events.findLast((event) => event.type === 'assistant/message' && event.message.content !== null)
if (safeAnswer === undefined || safeAnswer.type !== 'assistant/message') throw new Error('safe 应以最终回答收尾')
console.log(`  最终回答  → ${safeAnswer.message.content}`)

// —— 第四幕:patch——一行解锁 write_file,结局翻转 ——
console.log('\n—— 第四幕：patch——一行整行重述把 write_file 从 deny 提到 ask，结局翻转 ——')
const patchedApprovals: string[] = []
const patchedRun = await runProduct([layerOf(SAFE_PROFILE), UNLOCK_LAYER], PATCHED_SCRIPT, patchedApprovals, {
  '/sandbox/README.md': '本部署为只读分析环境。',
})
if (patchedApprovals.length !== 1 || !patchedApprovals[0]!.startsWith('write_file')) {
  throw new Error(`patch 后应恰好一次 write_file 审批，实际：${patchedApprovals.join('；') || '无'}`)
}
if (resultOf(patchedRun.events, 'p1').includes('权限拒绝：')) throw new Error('patch 后 write_file 应经批准执行')
const patchedRun2 = resultOf(patchedRun.events, 'p2')
if (!patchedRun2.includes('权限拒绝：')) throw new Error('patch 只解锁了 write_file：run_command 应仍被拒')
if (!resultOf(patchedRun.events, 'p3').includes('notes.md')) throw new Error('patch 后 list_dir 应看到刚写入的 notes.md')
console.log(`  write_file  → ${resultOf(patchedRun.events, 'p1')}（经 ask 批准——翻转）`)
console.log(`  run_command → ${patchedRun2}（同一行重述里照抄的 deny——没被顺带解锁）`)
console.log(`  list_dir    → ${resultOf(patchedRun.events, 'p3').replace('\n', ' ｜ ')}`)

console.log(
  [
    '',
    '收束：full / safe / patched-safe 三个产品共享同一份插件代码（BASE 的行 + TOOL_CATALOG 的工厂 + 唯一的 assembleBundle），',
    '差异只存在于层叠的数据：base（底座）→ profile（产品形态）→ patch（一行重述）。层序后写胜——dsh 的 --profile 旗子',
    '挑的就是第二层，--dump-config 离线打印的正是这台机器真会启动的那叠层（composeEntries 与 boot 用同一个算法）。',
  ].join('\n'),
)
