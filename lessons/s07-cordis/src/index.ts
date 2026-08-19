import { toolCall } from '@learn-dsh/mock-model'
import { Ctx, type EmitEvent, type Plugin, type ToolCallDecision } from './cordis'
import { SessionLog } from './log'
import { executeToolCall } from './pipeline'
import { registryOf } from './registry'
import { deleteFileTool, readFileTool } from './tools'

// 使用者侧的目录扩展（声明合并）：宿主给 EventMap 加自己的事件、给 ServiceMap
// 加 counter 服务的类型——cordis.ts 一个字都不用改，发收两端类型检查全覆盖。
// dsh 的插件就是这么往 SessionEventMap（packages/core/session/src/types.ts）里
// 合并自己的会话事件的；模块内外都能加键，这就是 merge-extensible。
declare module './cordis.js' {
  interface EventMap {
    /**
     * 宿主宣布一幕开始（本演示自定义的 emit 事件）。
     * payload.name：幕名。
     * @mode emit
     */
    'host/scene': EmitEvent<{ name: string }>
  }
  interface ServiceMap {
    /** counter 插件贡献的计步服务。 */
    counter: { steps: number }
  }
}

/** 审计留痕：effect 的挂载/回滚与每次工具裁决都落在这里——「可观测 effect」的观测面。 */
const auditTrail: string[] = []

/**
 * 审计插件：本课的「可观测 effect」样本。
 * effect 的效果体在注册这一刻就执行（push 挂载记录），它返回的清理函数
 * 由框架在插件卸载时调用（push 卸载记录）——效果与回滚成对出现，
 * 插件不需要（也没法）自己实现 unmount。
 */
const auditPlugin: Plugin = {
  name: 'audit',
  apply(ctx) {
    ctx.effect(() => {
      auditTrail.push('audit: mounted')
      return () => auditTrail.push('audit: unmounted')
    })
    // waterfall 观察者。链序 = 注册序，先挂载的在外层：审计要看到**每一次**
    // 裁决（包括内层的否决），所以排最外层；next() 的返回值是链的最终裁决，
    // 记录后原样返回——「只注记的监听器必须委托」。
    ctx.on('tool/call', (decision, next) => {
      const outcome = next(decision)
      auditTrail.push(
        `audit: ${outcome.name}(${JSON.stringify(outcome.args)}) → ${outcome.veto === undefined ? '放行' : '否决'}`,
      )
      return outcome
    })
  },
}

/**
 * 计步插件：本课的卸载对象。一个插件同时干两件事——
 * 贡献服务（service）+ 监听事件（on），两者都是 effect，卸载时全部回滚。
 */
const counterPlugin: Plugin = {
  name: 'counter',
  apply(ctx) {
    const counter = { steps: 0 }
    ctx.service('counter', counter)
    ctx.on('agent/step', () => {
      counter.steps += 1
    })
    ctx.effect(() => {
      auditTrail.push('counter: mounted（service("counter") + on("agent/step")）')
      return () => auditTrail.push('counter: unmounted')
    })
  },
}

/**
 * 护栏插件：本课的 waterfall 拦截器。三条路径演示拦截链的全部语义——
 * 否决（不调 next()，链到此为止）、改写（next(改写后的值)）、透传（next(原值)）。
 * s04 的 preExecute 守卫与它是同一个思想的两种挂法：守卫是循环参数，
 * 拦截器是插件——s08 把整个五件套搬进插件后两者合流。
 */
const guardPlugin: Plugin = {
  name: 'guard',
  apply(ctx) {
    ctx.on('tool/call', (decision, next) => {
      // 上游已否决：不重复裁决，原样透传（本插件在内层，正常流程走不到这条）
      if (decision.veto !== undefined) return next(decision)
      if (decision.name === 'delete_file' && decision.args.force !== true) {
        // 否决：返回但不调 next()——链到此为止，链尾的内置行为不会执行。
        return { ...decision, veto: '删除必须显式传 force: true（s04 的规矩，现在是插件拦截器）' }
      }
      if (decision.name === 'read_file' && !String(decision.args.path).startsWith('/')) {
        // 改写：相对路径补上工作区根。下游（链尾/内置行为）只能看到改写后的调用。
        return next({ ...decision, args: { ...decision.args, path: `/workspace/${String(decision.args.path)}` } })
      }
      return next(decision)
    })
  },
}

// —— 宿主：装配，然后只剩「驱动」——
// 挂载顺序即链序（先注册的在外层）：audit 最外、guard 最内。
// 卸载认 mount 返回的清理函数，与挂载顺序无关。
const ctx = new Ctx()
ctx.mount(auditPlugin)
const unmountCounter = ctx.mount(counterPlugin)
ctx.mount(guardPlugin)

// 宿主自己也可以监听（落在根作用域，不随任何插件卸载；进程结束前不会清理）。
// 'host/scene' 是上面声明合并进来的事件：键、载荷类型都来自使用者的声明。
ctx.on('host/scene', (payload) => {
  console.log(`[host/scene] ${payload.name}`)
})

// s06 资产照常在场（复制前进）：工具走 s02 以来的守卫管线执行，事实落 s03 日志。
const log = new SessionLog()
const registry = registryOf(readFileTool, deleteFileTool)

/**
 * 发起一次经过拦截链的工具调用：waterfall 决策，宿主按裁决执行。
 * 链尾（内置行为）是默认放行——所有拦截器都委托时，调用原样通过；
 * 任何拦截器否决，链在它那里断掉，宿主把否决理由落成回喂模型的 tool/result
 * （s02/s04 的规矩：否决是对话的一部分，不是进程崩溃）。
 * @param turn - 当前 turn 编号（落账用）。
 * @param decision - 进入链的初始裁决。
 */
async function runToolCall(turn: number, decision: ToolCallDecision): Promise<void> {
  const final = ctx.waterfall('tool/call', decision, (d) => d)
  log.append({
    type: 'tool/call',
    turn,
    callId: final.callId,
    name: final.name,
    arguments: JSON.stringify(final.args),
  })
  if (final.veto !== undefined) {
    log.append({ type: 'tool/result', callId: final.callId, output: `守卫否决：${final.veto}` })
    console.log(`  tool/call ${final.name}(${JSON.stringify(final.args)}) → 否决回喂：${final.veto}`)
    return
  }
  const record = await executeToolCall(registry, toolCall(final.callId, final.name, final.args))
  log.append({ type: 'tool/result', callId: final.callId, output: record.output })
  console.log(`  tool/call ${final.name}(${JSON.stringify(final.args)}) → 执行：${record.output}`)
}

// —— 第一幕：三个插件协作运转 ——
console.log('—— 第一幕：三个插件协作运转 ——')
log.append({ type: 'turn/start', turn: 1 })
ctx.emit('host/scene', { name: '装配完成' })
console.log(`已挂载插件：${ctx.plugins.join('、')}`)

console.log('emit agent/step { turn: 1, step: 1 } → counter 计步')
ctx.emit('agent/step', { turn: 1, step: 1 })
console.log(`读取服务 counter.steps = ${ctx.get('counter').steps}`)

console.log('read_file 带相对路径 → guard 改写为工作区绝对路径后执行：')
await runToolCall(1, { callId: 'c1', name: 'read_file', args: { path: 'notes/week.txt' } })

console.log('emit agent/step { turn: 1, step: 2 }')
ctx.emit('agent/step', { turn: 1, step: 2 })
console.log(`读取服务 counter.steps = ${ctx.get('counter').steps}`)

console.log('delete_file 缺 force → guard 否决（不调 next()，链短路）：')
await runToolCall(1, { callId: 'c2', name: 'delete_file', args: { path: '/tmp/old.log' } })

// —— 第二幕：卸载第一个插件（counter）——
console.log('\n—— 第二幕：卸载 counter 插件 ——')
unmountCounter()
console.log(`已挂载插件：${ctx.plugins.join('、')}（counter 的效果已全部回滚）`)
console.log('emit agent/step { turn: 1, step: 3 } → 无人计步：')
ctx.emit('agent/step', { turn: 1, step: 3 })
try {
  ctx.get('counter')
  throw new Error('counter 卸载后 get 应当报错')
} catch (error) {
  console.log(`读取服务 get("counter")：${(error as Error).message}`)
}
console.log('其余插件不受影响——再走一次拦截链：')
await runToolCall(1, { callId: 'c3', name: 'read_file', args: { path: 'readme.md' } })
log.append({ type: 'turn/end', turn: 1, reason: 'completed' })

// —— 收束：账本与留痕 ——
// 账本（s06 资产）：tool/call 与 tool/result 一一配对，否决也是对话的一部分；
// 留痕（effect 观测面）：挂载即记、卸载即回滚、每次裁决一行——逆序回滚的顺序就在这里。
console.log('\n—— 收束：账本与留痕 ——')
console.log(`SessionLog 共 ${log.events.length} 个事件：`)
for (const event of log.events) {
  switch (event.type) {
    case 'turn/start':
      console.log(`  turn ${event.turn} start`)
      break
    case 'turn/end':
      console.log(`  turn ${event.turn} end（reason: ${event.reason}）`)
      break
    case 'tool/call':
      console.log(`  tool/call ${event.name}(${event.arguments})`)
      break
    case 'tool/result':
      console.log(`  tool/result ${event.callId}：${event.output.slice(0, 44)}${event.output.length > 44 ? '…' : ''}`)
      break
    default:
      break
  }
}
console.log('auditTrail（注册即效果、卸载即逆序回滚的可观测面）：')
for (const line of auditTrail) console.log(`  ${line}`)
