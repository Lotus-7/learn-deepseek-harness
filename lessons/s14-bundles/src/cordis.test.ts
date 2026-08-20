import { describe, expect, it } from 'vitest'
import { Ctx, type EmitEvent, type WaterfallEvent } from './cordis'

// 测试文件自己的目录扩展（与 src/index.ts 的键不同：同名不同型的合并是类型冲突）：
// emit 键与 waterfall 键各加一个——「模块内外都能加键」的另一处证明。
declare module './cordis.js' {
  interface EventMap {
    /**
     * 测试扩展的 emit 事件。
     * payload.power：虚构的功率值。
     * @mode emit
     */
    'test/kicked': EmitEvent<{ power: number }>
    /**
     * 测试扩展的 waterfall 事件。
     * value.radius：半径；链上可改写。
     * @mode waterfall
     */
    'test/shape': WaterfallEvent<{ radius: number }>
  }
  interface ServiceMap {
    /** 测试扩展的服务。 */
    'test/beacon': { lit: boolean }
  }
}

describe('effect：注册即效果，回滚逆序且只回滚自己的', () => {
  it('效果体在注册这一刻执行（mount 返回时全部生效）', () => {
    const ctx = new Ctx()
    const events: string[] = []
    ctx.mount({
      name: 'a',
      apply(c) {
        for (const n of [1, 2, 3]) {
          c.effect(() => {
            events.push(`work-${n}`)
            return () => events.push(`undo-${n}`)
          })
        }
      },
    })
    expect(events).toEqual(['work-1', 'work-2', 'work-3'])
  })

  it('卸载即逆序回滚：后注册的先撤销（LIFO）', () => {
    const ctx = new Ctx()
    const order: string[] = []
    const unmount = ctx.mount({
      name: 'a',
      apply(c) {
        for (const n of [1, 2, 3]) {
          c.effect(() => () => order.push(`undo-${n}`))
        }
      },
    })
    expect(order).toEqual([])
    unmount()
    expect(order).toEqual(['undo-3', 'undo-2', 'undo-1'])
  })

  it('effect 返回的清理函数只回滚那一个效果，且单次有效', () => {
    const ctx = new Ctx()
    const undone: string[] = []
    const disposers: (() => void)[] = []
    const unmount = ctx.mount({
      name: 'a',
      apply(c) {
        disposers.push(c.effect(() => () => undone.push('first')))
        disposers.push(c.effect(() => () => undone.push('second')))
      },
    })
    disposers[0]!()
    disposers[0]!() // 单次有效：第二次是 no-op
    expect(undone).toEqual(['first'])
    unmount()
    // 提前回滚过的效果在插件卸载时不再重复执行，只剩第二个
    expect(undone).toEqual(['first', 'second'])
  })

  it('只回滚自己的：卸载 a，b 的效果原样保留', () => {
    const ctx = new Ctx()
    const undone: string[] = []
    const unmountA = ctx.mount({
      name: 'a',
      apply(c) {
        c.effect(() => () => undone.push('undo-a'))
      },
    })
    const unmountB = ctx.mount({
      name: 'b',
      apply(c) {
        c.effect(() => () => undone.push('undo-b'))
      },
    })
    unmountA()
    expect(undone).toEqual(['undo-a'])
    expect(ctx.plugins).toEqual(['b']) // b 还挂着
    unmountB()
    expect(undone).toEqual(['undo-a', 'undo-b']) // b 的效果在 b 卸载时才回滚
  })

  it('apply 抛错：已收集的效果立即回滚并原样上抛，插件不算已挂载', () => {
    const ctx = new Ctx()
    const undone: string[] = []
    expect(() =>
      ctx.mount({
        name: 'boom',
        apply(c) {
          c.effect(() => () => undone.push('undo'))
          throw new Error('apply 失败')
        },
      }),
    ).toThrow('apply 失败')
    expect(undone).toEqual(['undo']) // 半装状态不留
    expect(ctx.plugins).toEqual([])
  })

  it('级联：插件内 mount 的子插件随宿主卸载', () => {
    const ctx = new Ctx()
    const undone: string[] = []
    const unmountParent = ctx.mount({
      name: 'parent',
      apply(c) {
        c.effect(() => () => undone.push('undo-parent'))
        c.mount({
          name: 'child',
          apply(cc) {
            cc.effect(() => () => undone.push('undo-child'))
          },
        })
      },
    })
    expect(ctx.plugins).toEqual(['parent', 'child'])
    unmountParent()
    // 子插件的卸载作为父作用域里的一项，与父自己的效果一起 LIFO 回滚
    expect(undone).toEqual(['undo-child', 'undo-parent'])
    expect(ctx.plugins).toEqual([])
  })
})

describe('on/emit：typed events', () => {
  it('emit 按注册顺序广播，载荷与 EventMap 声明一致', () => {
    const ctx = new Ctx()
    const seen: string[] = []
    ctx.on('agent/step', (payload) => {
      const check: { turn: number; step: number } = payload // 类型来自声明；合并失效则这里编不过
      seen.push(`first ${check.turn}-${check.step}`)
    })
    ctx.on('agent/step', (payload) => seen.push(`second ${payload.turn}-${payload.step}`))
    ctx.emit('agent/step', { turn: 2, step: 3 })
    expect(seen).toEqual(['first 2-3', 'second 2-3'])
  })

  it('广播的是注册时快照：广播中自解绑不影响本次，下一次起缺席', () => {
    const ctx = new Ctx()
    const calls: string[] = []
    ctx.mount({
      name: 'a',
      apply(c) {
        const off = c.on('agent/step', () => {
          calls.push('self')
          off() // 广播中自解绑
        })
        c.on('agent/step', () => calls.push('after'))
      },
    })
    ctx.emit('agent/step', { turn: 1, step: 1 })
    expect(calls).toEqual(['self', 'after']) // 快照迭代：本次广播不受影响
    ctx.emit('agent/step', { turn: 1, step: 2 })
    expect(calls).toEqual(['self', 'after', 'after']) // 下一次起自解绑者缺席
  })

  it('监听器随插件卸载解绑', () => {
    const ctx = new Ctx()
    const calls: string[] = []
    const unmount = ctx.mount({
      name: 'a',
      apply(c) {
        c.on('agent/step', (payload) => calls.push(`step-${payload.step}`))
      },
    })
    ctx.emit('agent/step', { turn: 1, step: 1 })
    unmount()
    ctx.emit('agent/step', { turn: 1, step: 2 })
    expect(calls).toEqual(['step-1'])
  })
})

describe('waterfall：拦截链', () => {
  it('不调 next() 即短路：后续监听器与链尾内置行为都不执行', () => {
    const ctx = new Ctx()
    const calls: string[] = []
    ctx.on('tool/call', (decision) => {
      calls.push('vetoer')
      return { ...decision, veto: '链在第一环就断了' } // 不调 next()：否决即短路
    })
    ctx.on('tool/call', (decision, next) => {
      calls.push('downstream（不应到达）')
      return next(decision)
    })
    const final = ctx.waterfall(
      'tool/call',
      { callId: 'c1', name: 'delete_file', args: { path: '/tmp/x' } },
      () => {
        calls.push('builtin（不应到达）')
        return { callId: 'c1', name: 'delete_file', args: { path: '/tmp/x' } }
      },
    )
    expect(calls).toEqual(['vetoer'])
    expect(final.veto).toBe('链在第一环就断了')
  })

  it('全链委托：按注册序穿过，返回链尾内置行为的值', () => {
    const ctx = new Ctx()
    const calls: string[] = []
    ctx.on('tool/call', (decision, next) => {
      calls.push('outer')
      return next(decision)
    })
    ctx.on('tool/call', (decision, next) => {
      calls.push('inner')
      return next(decision)
    })
    const final = ctx.waterfall('tool/call', { callId: 'c1', name: 'echo', args: { text: 'hi' } }, (d) => {
      calls.push('builtin')
      return d
    })
    expect(calls).toEqual(['outer', 'inner', 'builtin'])
    expect(final).toEqual({ callId: 'c1', name: 'echo', args: { text: 'hi' } })
  })

  it('改写经 next() 的参数传给下游；下游与最终值看到的都是改写后的值', () => {
    const ctx = new Ctx()
    let seenByDownstream = ''
    ctx.on('tool/call', (decision, next) =>
      next({ ...decision, args: { ...decision.args, path: `/workspace/${String(decision.args.path)}` } }),
    )
    ctx.on('tool/call', (decision, next) => {
      seenByDownstream = String(decision.args.path)
      return next(decision)
    })
    const final = ctx.waterfall('tool/call', { callId: 'c1', name: 'read_file', args: { path: 'a.md' } }, (d) => d)
    expect(seenByDownstream).toBe('/workspace/a.md')
    expect(final.args.path).toBe('/workspace/a.md')
  })

  it('外层观察者从 next() 的返回值看到内层的否决（短路只断下游，不断上游）', () => {
    const ctx = new Ctx()
    let observedByOuter = ''
    ctx.on('tool/call', (decision, next) => {
      const outcome = next(decision) // 委托；返回值是内层产出的最终裁决
      observedByOuter = outcome.veto ?? ''
      return outcome
    })
    ctx.on('tool/call', (decision) => ({ ...decision, veto: '内层否决' }))
    const final = ctx.waterfall('tool/call', { callId: 'c1', name: 'delete_file', args: {} }, (d) => d)
    expect(final.veto).toBe('内层否决')
    expect(observedByOuter).toBe('内层否决')
  })

  it('监听器随插件卸载移出链；链回到只剩内置行为', () => {
    const ctx = new Ctx()
    const unmount = ctx.mount({
      name: 'guard',
      apply(c) {
        c.on('tool/call', (decision) => ({ ...decision, veto: '永远否决' }))
      },
    })
    const first = ctx.waterfall('tool/call', { callId: 'c1', name: 'echo', args: {} }, (d) => d)
    expect(first.veto).toBe('永远否决')
    unmount()
    const second = ctx.waterfall('tool/call', { callId: 'c2', name: 'echo', args: {} }, (d) => d)
    expect(second.veto).toBeUndefined()
  })
})

describe('声明合并：扩展的事件键类型可收发', () => {
  it('emit 键：扩展声明的载荷字段收发一致', () => {
    const ctx = new Ctx()
    const received: number[] = []
    ctx.on('test/kicked', (payload) => {
      const check: { power: number } = payload // 类型来自本文件的 declare module
      received.push(check.power)
    })
    ctx.emit('test/kicked', { power: 42 })
    expect(received).toEqual([42])
  })

  it('waterfall 键：扩展声明的值类型在链上收发一致', () => {
    const ctx = new Ctx()
    ctx.on('test/shape', (value, next) => next({ radius: value.radius * 2 }))
    const final = ctx.waterfall('test/shape', { radius: 3 }, (v) => v)
    expect(final.radius).toBe(6)
  })
})

describe('service：贡献与注销', () => {
  it('贡献即可读；重名贡献响亮报错且不顶掉前者', () => {
    const ctx = new Ctx()
    ctx.mount({
      name: 'a',
      apply(c) {
        c.service('test/beacon', { lit: true })
      },
    })
    expect(ctx.get('test/beacon')).toEqual({ lit: true })
    expect(() =>
      ctx.mount({
        name: 'b',
        apply(c) {
          c.service('test/beacon', { lit: false }) // 重名：静默顶掉前者比报错危险
        },
      }),
    ).toThrow('已贡献')
    expect(ctx.plugins).toEqual(['a']) // 装配失败的 b 没挂上
    expect(ctx.get('test/beacon')).toEqual({ lit: true })
  })

  it('注销后读取响亮报错（列出当前服务）；其它服务不受影响', () => {
    const ctx = new Ctx()
    const unmountBeacon = ctx.mount({
      name: 'a',
      apply(c) {
        c.service('test/beacon', { lit: true })
      },
    })
    ctx.mount({
      name: 'b',
      apply(c) {
        c.service('counter', { steps: 0 })
      },
    })
    unmountBeacon()
    expect(() => ctx.get('test/beacon')).toThrow('没有叫 "test/beacon" 的服务')
    expect(() => ctx.get('test/beacon')).toThrow(/counter/) // 报错列出还活着的服务
    expect(ctx.get('counter')).toEqual({ steps: 0 }) // 邻居不受影响
  })

  it('服务注销是 effect：逆序回滚里排在后注册的效果之后', () => {
    const ctx = new Ctx()
    let readDuringRollback = '未读'
    const unmount = ctx.mount({
      name: 'a',
      apply(c) {
        c.service('test/beacon', { lit: true })
        // 这个 effect 注册晚于 service，回滚先于 service 注销——undo 里服务还在
        c.effect(() => () => {
          readDuringRollback = String(c.get('test/beacon').lit)
        })
      },
    })
    unmount()
    expect(readDuringRollback).toBe('true')
    expect(() => ctx.get('test/beacon')).toThrow('没有叫')
  })
})
