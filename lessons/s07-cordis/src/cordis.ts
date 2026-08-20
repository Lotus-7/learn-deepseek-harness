/**
 * 迷你 Cordis：ctx、可逆 effect、typed events——一切皆插件（本课主角，零依赖）。
 *
 * 它是 vendored Cordis（dsh 的插件框架底座）的教学投影，四个机制一一对应：
 *
 * | 本课 | 真 Cordis（vendor/cordis/src） | 差距 |
 * |---|---|---|
 * | `Ctx` 类 | `Context` 类（context.ts）+ 代理（reflect.ts） | 真 Context 是 Proxy：属性读取走服务解析层，还有 extend/isolate/intercept 三种 scope |
 * | `effect()` 收集逆序清理 | `Fiber.effect()`（fiber.ts） | 真版 effect 体可返回 Promise/可迭代对象；清理可异步，卸载会等待它 |
 * | `on()`/`emit()`/`waterfall()` | `EventsService`（events.ts） | 真版有五种分发模式（emit/waterfall/parallel/serial/bail），本课收两种 |
 * | `service()`/`get()` | `ctx.provide()`/`ctx.get()`（reflect.ts）与 Service 基类（service.ts） | 真版服务随 fiber 激活对依赖方可见、随卸载注销并唤醒等待者（inject 声明依赖） |
 * | `mount()` | `RegistryService.plugin()`（registry.ts）+ Fiber | 真版 Fiber 是完整生命周期状态机（PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING），支持热重载与配置校验 |
 *
 * 核心不变式与真 Cordis 相同：**注册即效果（registrations are effects）**——
 * 一切贡献（监听器、服务、任何副作用）都经过 `effect()` 收集，插件卸载即逆序回滚。
 */

/** 清理函数：回滚一个已注册的效果。与真 Cordis 的 Disposable 对应（可异步，本课收同步）。 */
export type Disposer = () => void

/**
 * emit 事件的描述（幻影类型，运行时永不构造）：监听器**观察** payload，不能改写。
 * 发射方式是事件公开契约的一部分——真 Cordis 用 JSDoc 的 `@mode` 标注并由生成的
 * 事件目录核对（docs/cordis-primer.md 的 Dispatch Modes 一节），本课把它编进类型：
 * `emit` 事件的键只能用 {@link Ctx.emit} 发射，`waterfall` 事件的键只能用
 * {@link Ctx.waterfall} 发射，发错方法在编译期就是类型错误。
 */
export interface EmitEvent<P> {
  /** 幻影标记：emit 方式（只观察）。 */
  readonly mode: 'emit'
  /** 监听器收到的载荷。 */
  readonly payload: P
}

/**
 * waterfall 事件的描述（幻影类型）：监听器组成**拦截链**，依次收到
 * `(value, next)`；调 `next()` 把（可能改写过的）value 委托给下一个监听器，
 * 不调即短路——链到此为止，最终值就是它的返回值。对应真 Cordis 的
 * around-middleware 语义（events.ts 的 waterfall：`cbs.shift() ?? inner`）。
 */
export interface WaterfallEvent<V> {
  /** 幻影标记：waterfall 方式（拦截链）。 */
  readonly mode: 'waterfall'
  /** 在链上流动、可被改写或否决的值。 */
  readonly value: V
}

/** 从事件描述里提取 emit 载荷类型。 */
export type EventPayload<E> = E extends { readonly payload: infer P } ? P : never

/** 从事件描述里提取 waterfall 值类型。 */
export type EventValue<E> = E extends { readonly value: infer V } ? V : never

/** 事件表里所有 emit 方式的键。 */
export type EmitKeys<M> = { [K in keyof M]: M[K] extends { readonly mode: 'emit' } ? K : never }[keyof M]

/** 事件表里所有 waterfall 方式的键。 */
export type WaterfallKeys<M> = { [K in keyof M]: M[K] extends { readonly mode: 'waterfall' } ? K : never }[keyof M]

/**
 * 一个事件的监听器签名，由事件描述的 mode 决定：
 * emit 事件是 `(payload) => void`（只观察）；waterfall 事件是
 * `(value, next) => value`（必须调 `next()` 委托，不调即短路）。
 */
export type ListenerFor<E> = E extends { readonly mode: 'emit'; readonly payload: infer P }
  ? (payload: P) => void
  : E extends { readonly mode: 'waterfall'; readonly value: infer V }
    ? (value: V, next: (rewritten?: V) => V) => V
    : never

/**
 * 事件目录（merge-extensible）：事件名 → 事件描述。
 * 模块内外的使用者都用声明合并往里加键（`declare module './cordis.js'`，
 * 见 src/index.ts 的演示）——扩展不改本文件，类型检查全覆盖。
 * dsh 的同款机制：SessionEventMap（packages/core/session/src/types.ts）与
 * agent 事件表（packages/core/agent/src/runtime-types.ts），插件各自声明合并。
 */
export interface EventMap {
  /**
   * 一次模型步骤开始（观察型广播）。
   * payload.turn：步骤所属的 turn 编号（从 1 起）；payload.step：turn 内的步骤序号（从 1 起）。
   * @mode emit
   */
  'agent/step': EmitEvent<{ turn: number; step: number }>
  /**
   * 一次工具调用穿过拦截链（可改写、可否决）。
   * 值是 {@link ToolCallDecision}：拦截器可以改写 args、置 veto 否决，
   * 或原样 `next()` 放行。链尾（内置行为）由发起 waterfall 的宿主提供——
   * dsh 的同位事件是 tools/pre-execute 瀑布（s04 的 preExecute 守卫是它的
   * 无插件前身；本课 src/index.ts 用它扮演权限插件）。
   * @mode waterfall
   */
  'tool/call': WaterfallEvent<ToolCallDecision>
}

/**
 * tool/call 瀑布上流动的值：一次待执行的工具调用及其裁决。
 * 拦截器改写它会直接改变最终执行（或否决回喂）的内容。
 */
export interface ToolCallDecision {
  /** 调用 id：与 tool/result 事件配对（s03 的规矩）。 */
  callId: string
  /** 工具名。 */
  name: string
  /** 工具参数：拦截器可改写（比如补默认值、脱敏）。 */
  args: Record<string, unknown>
  /** 否决理由：非空表示链上已有拦截器否决——下游应原样透传，宿主不执行、把理由回喂模型。 */
  veto?: string
}

/**
 * 服务目录（merge-extensible）：服务名 → 服务实例类型。
 * 迷你核心不贡献任何服务——目录完全由插件用声明合并扩展（与真 Cordis 的
 * Context 接口同构：核心只带 events/registry 等框架服务，业务服务全部由
 * 插件合并进去，`ctx.tools`、`ctx.llm` 就是这么来的）。
 */
export interface ServiceMap {}

/**
 * 插件：一个名字 + 一段往 ctx 上注册效果的函数。
 * 对应真 Cordis 的 Object 插件形态 `{ apply(ctx, config) }`（registry.ts；
 * 另有函数/类两种形态，且可声明 inject 依赖与 Config 校验——本课未收录）。
 */
export interface Plugin {
  /** 插件名：诊断与演示输出用。不参与身份——同名插件可多次挂载，卸载认 mount 返回的清理函数。 */
  name: string
  /** 插件体：在这里注册 effect/监听/服务。注册即效果，apply 返回时它们已全部生效。 */
  apply(ctx: Ctx): void
}

/** 内部监听器记录的宽松形态（类型安全的封装在 on/waterfall 的签名上）。 */
type AnyListener = (value?: unknown, next?: () => unknown) => unknown

/**
 * 上下文：插件的注册面与服务仓库。
 * 三个注册方法（effect/on/service）全都**注册即效果**，全部返回清理函数；
 * mount 给每个插件开独立作用域，卸载即逆序回滚它的全部效果。
 */
export class Ctx {
  /** 根作用域：不在插件里注册的 effect 落在这里（宿主直接用 ctx 时）。 */
  private readonly rootScope: Disposer[] = []
  /** 当前 effect 落入的作用域：mount 进入插件时切换，apply 结束后切回。 */
  private currentScope: Disposer[] = this.rootScope
  /** 事件名 → 监听器列表（按注册顺序；waterfall 的链序同此）。 */
  private readonly listeners = new Map<string, AnyListener[]>()
  /** 服务名 → 实例。贡献与注销都是 effect。 */
  private readonly services = new Map<string, unknown>()
  /** 已挂载的插件名（按挂载顺序）；卸载即移除。演示与诊断用。 */
  private readonly pluginNames: string[] = []

  /** 当前已挂载的插件名快照（按挂载顺序）。 */
  get plugins(): readonly string[] {
    return [...this.pluginNames]
  }

  /**
   * 注册一个效果：**立即执行 setup**（效果在注册这一刻就发生，不是等某个
   * activate 钩子），把 setup 返回的清理函数收入当前作用域。
   * 「注册即效果」是插件可逆性的根基：效果与它的回滚在同一个注册点成对出现，
   * 谁注册谁负责给出回滚——于是「卸载一个插件」不需要插件配合，框架逆序
   * 调用清单上的清理函数即可；没有这条例子，卸载就得靠每个插件自觉实现
   * unmount，漏一个就是泄漏。
   * 对应真 Cordis 的 Fiber.effect（fiber.ts）：它还接受返回 Promise 或
   * 可迭代多个清理函数的 setup，清理可异步、卸载会等待。
   * @param setup - 效果体：做工作，返回它的清理函数。工作已在外做完的惯用形式是 `ctx.effect(() => stop)`。
   * @returns 提前回滚这个效果的清理函数（单次有效；插件卸载时未提前回滚的会被逆序执行）。
   */
  effect(setup: () => Disposer): Disposer {
    const scope = this.currentScope
    const dispose = setup()
    scope.push(dispose)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const index = scope.indexOf(dispose)
      if (index >= 0) scope.splice(index, 1)
      dispose()
    }
  }

  /**
   * 监听一个事件。**注册本身也走 effect**：解绑函数包在 effect 里，
   * 插件卸载时监听器随之消失（与真 Cordis 的 EventsService.register 相同：
   * `this.ctx.fiber.effect(() => { hooks.push(...); return () => this.unregister(...) })`）。
   * @param event - 事件名（EventMap 的键；扩展事件用声明合并加入）。
   * @param listener - emit 事件收 `(payload)`，waterfall 事件收 `(value, next)` 且必须调 `next()` 委托。
   * @returns 解绑函数（单次有效）。
   */
  on<K extends keyof EventMap>(event: K, listener: ListenerFor<EventMap[K]>): Disposer {
    const list = this.listeners.get(event) ?? []
    this.listeners.set(event, list)
    list.push(listener as AnyListener)
    return this.effect(() => () => {
      // 按身份移除第一个匹配（真 Cordis 的 unregister 同款）：同一监听器注册
      // 两次就有两个记录，各自的解绑函数各自撤一份。
      const index = list.indexOf(listener as AnyListener)
      if (index >= 0) list.splice(index, 1)
    })
  }

  /**
   * 贡献一个服务：把实例挂到服务名下，返回注销函数（注册同样走 effect，
   * 插件卸载时服务随之消失）。重名贡献当场抛出——两个插件写同一个键，
   * 后者会静默顶掉前者，比启动失败危险得多（真 Cordis 的 provide 同样
   * 在重名时抛错）。dsh 的每个能力 seam 都是这样一个服务：tools、llm、
   * sessions……插件甲贡献、插件乙消费，互相不 import 具体实现。
   * @param key - 服务名（ServiceMap 的键；由插件用声明合并扩展）。
   * @param instance - 服务实例。
   * @returns 注销函数（单次有效）。
   * @throws 服务名已被贡献。
   */
  service<K extends keyof ServiceMap>(key: K, instance: ServiceMap[K]): Disposer {
    if (this.services.has(key)) {
      throw new Error(`服务 "${String(key)}" 已贡献（当前服务：${[...this.services.keys()].join(', ') || '无'}）；重名通常是重复装配，请检查贡献方`)
    }
    this.services.set(key, instance)
    return this.effect(() => () => {
      this.services.delete(key)
    })
  }

  /**
   * 读取一个服务。**取舍：不存在的服务响亮报错而不是返回 undefined。**
   * 真 Cordis 的 ctx.get 返回 undefined、依赖方用 inject 声明「等服务出现」
   * （插件在依赖就绪前根本不加载，undefined 只用于探测）；本课没有 inject
   * 机制，静默 undefined 会把装配错误推迟到很远的地方才爆——按 dsh 的
   * 「misconfiguration fails loud」约定，拿不到就是装配错了，当场报，
   * 错误信息列出当前全部服务名（与 s02 ToolRegistry.lookup 同款）。
   * @param key - 服务名。
   * @returns 服务实例。
   * @throws 服务未被贡献（列出当前服务）。
   */
  get<K extends keyof ServiceMap>(key: K): ServiceMap[K] {
    if (!this.services.has(key)) {
      throw new Error(`没有叫 "${String(key)}" 的服务（当前服务：${[...this.services.keys()].join(', ') || '无'}）`)
    }
    return this.services.get(key) as ServiceMap[K]
  }

  /**
   * 同步广播一个 emit 事件：监听器按注册顺序**观察**，没有返回值、
   * 不能改写载荷。迭代快照——监听器里解绑（自己或别人）不影响本次广播。
   * 对应真 Cordis 的 emit（还有 parallel/serial/bail 三种本课未收录的
   * 分发方式：并行等待、顺序等待首个 bail、同步取首个 bail）。
   * @param event - 事件名（必须是 emit 方式的键；waterfall 键在这里是类型错误）。
   * @param payload - 载荷，原样发给每个监听器。
   */
  emit<K extends EmitKeys<EventMap>>(event: K, payload: EventPayload<EventMap[K]>): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      ;(listener as (payload: EventPayload<EventMap[K]>) => void)(payload)
    }
  }

  /**
   * 发起一条 waterfall 拦截链：监听器按注册顺序组成链（先注册的在外层），
   * 每个收到 `(value, next)`。**必须调 `next()` 委托**——链继续；`next()`
   * 原样委托，`next(改写后的值)` 以新值继续（真 Cordis 的协作用法是改共享
   * 对象后 `next()`：调用方持有同一引用，两种写法在这里等价）。
   * **不调 next() 即短路**：这不是错误，是设计——单决策事件里「拥有决定权的
   * 监听器」用返回代替委托（否决），只观察/注记的监听器必须委托
   * （真 Cordis 语义，见 docs/cordis-primer.md 的 Cordis Waterfall Semantics）。
   * @param event - 事件名（必须是 waterfall 方式的键）。
   * @param value - 进入链的初始值。
   * @param next - 链尾的内置行为：收到链上最终传下来的值（所有监听器都委托时的
   * 最后一个），返回值就是 waterfall 的返回值。
   * @returns 链的最终值：全部委托则是内置行为的返回值；中途短路则是短路监听器的返回值。
   */
  waterfall<K extends WaterfallKeys<EventMap>>(
    event: K,
    value: EventValue<EventMap[K]>,
    next: (value: EventValue<EventMap[K]>) => EventValue<EventMap[K]>,
  ): EventValue<EventMap[K]> {
    const chain = [...(this.listeners.get(event) ?? [])]
    const dispatch = (index: number, current: EventValue<EventMap[K]>): EventValue<EventMap[K]> => {
      const listener = chain[index] as
        | ((value: EventValue<EventMap[K]>, next: (rewritten?: EventValue<EventMap[K]>) => EventValue<EventMap[K]>) => EventValue<EventMap[K]>)
        | undefined
      if (listener === undefined) return next(current)
      return listener(current, (rewritten?: EventValue<EventMap[K]>) => dispatch(index + 1, rewritten ?? current))
    }
    return dispatch(0, value)
  }

  /**
   * 挂载一个插件：开一个新的效果作用域，立即执行 `apply(ctx)`（注册即效果，
   * apply 返回时插件的全部贡献已生效），然后切回原作用域。
   * 返回卸载函数；卸载即**逆序回滚**该插件的全部效果——后注册的先撤销
   * （LIFO）：效果往往依赖先前的效果，逆序撤销不会拆到还在被依赖的东西
   * （真 Cordis 同款：fiber.ts 的 `disposables.splice(0).reverse()`）。
   * apply 抛错则已收集的效果立即回滚并原样上抛——半装状态不留在 ctx 上。
   * 在插件内 mount 子插件时，子的卸载挂进父的作用域：父卸载，子级联卸载
   * （对应真 Cordis 的 fiber 父子生命周期：`fiber.dispose = parent.fiber.effect(...)`）。
   * @param plugin - 插件对象。
   * @returns 卸载函数（单次有效；逆序回滚该插件作用域内全部效果）。
   * @throws apply 抛错时：回滚已收集效果后原样上抛。
   */
  mount(plugin: Plugin): Disposer {
    const scope: Disposer[] = []
    const parentScope = this.currentScope
    this.currentScope = scope
    // 先入列再 apply：子插件在 apply 里 mount 时，挂载名单的顺序与调用顺序一致
    // （父在前）；apply 抛错则从名单撤回。
    this.pluginNames.push(plugin.name)
    try {
      plugin.apply(this)
    } catch (error) {
      const index = this.pluginNames.indexOf(plugin.name)
      if (index >= 0) this.pluginNames.splice(index, 1)
      rollback(scope)
      throw error
    } finally {
      this.currentScope = parentScope
    }
    let unmounted = false
    const unmount = (): void => {
      if (unmounted) return
      unmounted = true
      const index = this.pluginNames.indexOf(plugin.name)
      if (index >= 0) this.pluginNames.splice(index, 1)
      rollback(scope)
    }
    // 在插件作用域内 mount 的子插件，其卸载挂进父作用域：父卸载，子级联卸载；
    // 宿主自己 mount 的插件不进任何作用域，只认返回的卸载函数。
    if (parentScope !== this.rootScope) parentScope.push(unmount)
    return unmount
  }
}

/** 逆序执行并清空一个作用域：后注册的先回滚（LIFO）。 */
function rollback(scope: Disposer[]): void {
  for (const dispose of scope.splice(0).reverse()) dispose()
}
