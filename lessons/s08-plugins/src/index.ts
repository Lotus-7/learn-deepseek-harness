import { createMockModel, toolCall, type ChatMessage, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx, type Plugin } from './cordis'
import { deterministicSummarize, estimateTokens } from './compaction'
import { SessionLog } from './log'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { permissionPlugin, type PermissionPlugin } from './plugin-permission'
import { compactionPlugin } from './plugin-compaction'
import { loopPlugin } from './plugin-loop'
import {
  addTool,
  cachedStatsTool,
  deleteFileTool,
  echoTool,
  fetchStatsTool,
  moveToTrashTool,
  readFileTool,
  searchLogsTool,
  slowScanTool,
  type Tool,
} from './tools'

// —— s06 的三幕剧本与配置原样照搬：本课的命题是「同一剧本、同一行为，
// 但每一件能力都是一个可替换、可卸载的插件」。——
const SCRIPT: { userText: string; responses: ModelResponse[] }[] = [
  {
    userText: '我们的生产集群一共 47 台节点，最近超时报警很多。帮我从部署日志里分别查 timeout 和 restart 两种模式，给个初步判断。',
    responses: [
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'search_logs', { query: 'timeout' })] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'search_logs', { query: 'restart' })] }, finishReason: 'tool_calls' },
      {
        message: { role: 'assistant', content: '两种模式各命中 24 行。timeout 的延迟随 svc 编号走高，restart 集中在 svc-01，初步判断它过载引发级联重启。' },
        finishReason: 'stop',
      },
    ],
  },
  {
    userText: '继续深挖：再查一下 upstream_reset 的日志。',
    responses: [
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('t3', 'search_logs', { query: 'upstream_reset' })] }, finishReason: 'tool_calls' },
      {
        message: { role: 'assistant', content: 'upstream_reset 与 restart 的分布重合，判断坐实：上游依赖反复重置连接。建议对 svc-01 的上游做限流并观察 restart 曲线。' },
        finishReason: 'stop',
      },
    ],
  },
  {
    userText: '顺便确认一下：我们的集群一共多少台节点来着？',
    responses: [
      {
        message: { role: 'assistant', content: '我们的集群一共 47 台节点——这个数字来自开场的背景摘要，原文早已被压缩掉，但事实还在。' },
        finishReason: 'stop',
      },
    ],
  },
]

/** s06 同款九工具与权限规则、压缩阈值——「重构不改行为」的对照组就是这套配置。 */
const TOOLS: Tool[] = [
  addTool,
  echoTool,
  deleteFileTool,
  readFileTool,
  moveToTrashTool,
  slowScanTool,
  fetchStatsTool,
  cachedStatsTool,
  searchLogsTool,
]

const S06_RULES = {
  read_file: 'allow',
  move_to_trash: 'allow',
  add: 'allow',
  echo: 'allow',
  delete_file: 'ask',
  slow_scan: 'allow',
  fetch_stats: 'allow',
  cached_stats: 'allow',
  search_logs: 'allow',
} as const

/**
 * 观察插件（第六插件，本演示的临时演员）：只挂三个事件监听，不贡献任何服务。
 * 它就是「一个插件看懂整个系统」的最小样本——observe.ts 一个字不进五件套，
 * 五件套也一个字不知道它；拆掉它，一切照旧。
 */
const observePlugin: Plugin = {
  name: 'observe',
  apply(ctx) {
    ctx.on('agent/step', ({ turn, step }) => console.log(`  [observe] agent/step ${turn}-${step}`))
    // 最外层瀑布观察者（先挂载所以在链最外）：next() 的返回值是链的最终裁决。
    ctx.on('tools/pre-execute', async (decision, next) => {
      const outcome = await next(decision)
      const verdict = outcome.veto === undefined ? `放行（${decision.name}）` : `否决（${decision.name}）`
      console.log(`  [observe] tools/pre-execute → ${verdict}`)
      return outcome
    })
    ctx.on('session/event', ({ event }) => {
      if (event.type === 'session/compacted') {
        console.log(`  [observe] session/compacted：压掉 ${event.shadowedCount} 条头部，估算 ${event.tokensBefore} → ${event.tokensAfter} token`)
      }
    })
  },
}

/**
 * 装配一个世界：五个能力插件 + observe。permission/compaction 可换件——
 * 「换一个插件 = 换一个世界」的全部动作就是改这两个参数。
 */
function assemble(replacements: { permission?: Plugin; compaction?: Plugin } = {}): Ctx {
  const ctx = new Ctx()
  // observe 第一个挂载 → 它的瀑布观察者在链最外层，能看到每一次最终裁决
  // （否决短路只断下游，外层从 next() 的返回值照样看到——s07 的语义）。
  ctx.mount(observePlugin)
  ctx.mount(modelPlugin(createMockModel(SCRIPT.flatMap((turn) => turn.responses))))
  ctx.mount(toolsSessionPlugin(TOOLS))
  ctx.mount(replacements.permission ?? permissionPlugin({ rules: { ...S06_RULES } }))
  ctx.mount(replacements.compaction ?? compactionPlugin({ threshold: 700, keepTail: 4, summarize: deterministicSummarize }))
  ctx.mount(loopPlugin())
  return ctx
}

/** 跑完整三幕剧本，返回（观察者视角的）模型请求记录。 */
async function runScript(ctx: Ctx): Promise<void> {
  for (const turn of SCRIPT) await ctx.get('agent').run(turn.userText)
}

/** 打印一段派生历史的第一条（压缩后它就是检查点摘要）。 */
function printFirstMessage(messages: readonly ChatMessage[]): void {
  const first = messages[0]
  const preview = (first?.content ?? '').split('\n').slice(0, 3).join(' / ')
  console.log(`    第一条：[${first?.role ?? '?'}] ${preview}${(first?.content ?? '').length > 3 ? '…' : ''}`)
}

// —— 第一幕：五件套组装，s06 剧本原样重跑 ——
console.log('—— 第一幕：五件套插件组装，s06 剧本原样重跑 ——')
const actOne = assemble()
console.log(`已挂载插件：${actOne.plugins.join('、')}`)
await runScript(actOne)
const logOne = actOne.get('sessions').log
const compactedOne = logOne.events.findLast((event) => event.type === 'session/compacted')
if (compactedOne?.type !== 'session/compacted') throw new Error('第一幕剧本没有触发压缩：检查阈值与工具输出规模')
console.log(
  `账本 ${logOne.events.length} 个事件、压缩 ${logOne.events.filter((event) => event.type === 'session/compacted').length} 次；` +
    `最终回答：${logOne.deriveMessages().at(-1)?.content ?? ''}`,
)
console.log('与 s06 快照的等价由测试钉住：整份日志逐事件相等（plugins.test.ts 第一组）。')

// —— 第二幕：换一个更严的 permission 插件，其余代码零改动 ——
console.log('\n—— 第二幕：换更严的 permission 插件（deny 危险工具），其余零改动 ——')
const strictPermission: PermissionPlugin = permissionPlugin({
  rules: { '*': 'deny', read_file: 'allow' },
  defaultDecision: 'deny',
})
const actTwo = assemble({ permission: strictPermission })
console.log(`已挂载插件：${actTwo.plugins.join('、')}（permission 换成严规则实例）`)
await runScript(actTwo)
const logTwo = actTwo.get('sessions').log
const toolResultsTwo = logTwo.events.filter((event) => event.type === 'tool/result')
console.log(`账本 ${logTwo.events.length} 个事件：三次 search_logs 全被拦下，tool/result 只有 ${toolResultsTwo.length} 条否决文本`)
for (const event of toolResultsTwo) {
  if (event.type !== 'tool/result') continue
  console.log(`    ${event.output}`)
}
console.log(
  `对照第一幕：回喂从 3×24 行日志变成 3 条否决文本，预算不再超阈值——压缩 ${logTwo.events.filter((event) => event.type === 'session/compacted').length} 次。`,
)
console.log('permission 守卫一行没改（permission.ts 原样）：换的是挂它的插件实例。')

// —— 第三幕：换注入极简摘要器的 compaction 插件 ——
console.log('\n—— 第三幕：换 compaction 插件的摘要器，压缩时机不变、检查点内容即变 ——')
const minimalSummarize = async (messages: readonly ChatMessage[]): Promise<string> => `极简摘要：早期 ${messages.length} 条消息。`
const actThree = assemble({ compaction: compactionPlugin({ threshold: 700, keepTail: 4, summarize: minimalSummarize }) })
console.log(`已挂载插件：${actThree.plugins.join('、')}（compaction 换成极简摘要器实例）`)
await runScript(actThree)
const logThree = actThree.get('sessions').log
const compactedThree = logThree.events.findLast((event) => event.type === 'session/compacted')
if (compactedThree?.type !== 'session/compacted') throw new Error('第三幕剧本没有触发压缩：换摘要器不应改变触发时机')
console.log(`压缩发生在同一步骤边界：压掉 ${compactedThree.shadowedCount} 条头部，估算 ${compactedThree.tokensBefore} → ${compactedThree.tokensAfter} token（第一幕：${compactedOne.tokensBefore} → ${compactedOne.tokensAfter}）`)
/** 摘掉 <compacted-summary> 框架，只看摘要器产出本身。 */
const inner = (summary: string): string => summary.split('<compacted-summary>\n')[1]?.split('\n</compacted-summary>')[0] ?? summary
console.log('第一幕的摘要（确定性摘要器——机械保留要点与数字事实）：')
console.log(`  ${inner(compactedOne.summary).split('\n').slice(0, 3).join('\n  ')}`)
console.log('第三幕的摘要（极简摘要器——只报条数）：')
console.log(`  ${inner(compactedThree.summary)}`)
console.log('压缩后模型实际收到的请求（第三幕 turn 2 第二次调用）：')
printFirstMessage(logThree.deriveMessages())

// —— 收束：卸载插件，响亮失败；账本可回放可分叉 ——
console.log('\n—— 收束：卸载插件响亮报错，不静默空转 ——')
const finale = new Ctx()
const unmountModel = finale.mount(modelPlugin(createMockModel([])))
finale.mount(toolsSessionPlugin(TOOLS))
finale.mount(permissionPlugin({ rules: { ...S06_RULES } }))
finale.mount(compactionPlugin({ threshold: 700, keepTail: 4, summarize: deterministicSummarize }))
finale.mount(loopPlugin())
unmountModel()
console.log(`卸载 model 插件后：已挂载 ${finale.plugins.join('、')}`)
try {
  await finale.get('agent').run('随便问点什么')
  throw new Error('卸载后 run 不该成功——这段不该被执行')
} catch (error) {
  console.log(`agent.run("随便问点什么") → ${(error as Error).message}`)
}
console.log(`日志事件数：${finale.get('sessions').log.events.length}（零事件——报错发生在第一个事实落账之前，不是空转半截 turn）`)

const replayed = SessionLog.replay(logOne.events)
console.log('\n—— 账本与回放（第一幕）——')
console.log(
  `重放整份日志重建派生历史：${replayed.deriveMessages().length} 条 = 原始 ${logOne.deriveMessages().length} 条；` +
    `当前派生历史估算 ${estimateTokens(logOne.deriveMessages())} token`,
)
const lastTurnEndBeforeCompaction = logOne.events.slice(0, compactedOne.seq).findLast((event) => event.type === 'turn/end')
if (lastTurnEndBeforeCompaction === undefined) throw new Error('演示剧本里压缩点之前没有闭合的 turn')
const child = logOne.fork(lastTurnEndBeforeCompaction.seq)
console.log(
  `从压缩前最后一个 turn/end（seq=${lastTurnEndBeforeCompaction.seq}）fork：支线派生历史 ${child.deriveMessages().length} 条（未压缩的完整历史）——插件化没有动过 append-only 的地基。`,
)
