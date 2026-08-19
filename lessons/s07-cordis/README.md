# s07 · cordis：ctx、可逆 effect、typed events——一切皆插件

> 插件不是「可以卸载的功能」，是「注册时就带着回滚方案的功能」。效果与回滚成对出现，卸载才不需要插件配合。

## 为什么

回看 s01–s06 的五件套：守卫是 `preExecute` 数组，压缩是 `compaction` 对象，取消是
`signal`——每加一个能力，`runLoop` 的参数表就长一行，s06 的注释里甚至预告了
「s07/s08 会把它变成真正的插件」。参数注入的天花板是：**换一个世界（换权限策略、
换压缩后端、换执行环境）等于换一处装配代码**，而且运行中不可拆装。插件系统把
「能力」从参数变成可以独立挂载、独立卸载、互相发现的单元——dsh 的口号
「everything is a plugin」说的就是这件事，它的底座是 vendored 的 Cordis。本课从零
写一个迷你 Cordis（`src/cordis.ts`，约 330 行，零依赖），三块基石：

1. **注册即效果（registrations are effects）——插件可逆性的根基。** `ctx.effect(setup)`
   在注册这一刻就执行 setup（效果当场发生，不是等某个 activate 钩子），setup 返回
   的清理函数进当前作用域。关键在「成对」：效果与它的回滚在同一个注册点一起交
   给框架，于是**卸载不需要插件配合**——框架逆序调用清单上的清理函数即可。没有
   这条例子，卸载就得靠每个插件自觉实现 unmount，漏一个就是泄漏；有了它，监听器、
   服务、任何副作用的生死都由框架掌管。`on()` 与 `service()` 的注册**本身也走
   effect**（解绑/注销就是它们的清理函数），所以「事件解绑、服务消失」不需要单独
   的机制——它们只是 effect 回滚的三种面貌。逆序（LIFO）因为效果往往依赖先前的
   效果：后注册的先撤销，不会拆到还在被依赖的东西。
2. **typed events 用声明合并扩展，核心文件不用改。** 事件目录 `EventMap` 是一个
   普通 interface；任何文件（模块内外都行）用 `declare module './cordis.js'` 往里
   加键，发收两端立刻获得完整类型检查——`emit` 载荷字段拼错、监听一个不存在的
   事件、**用 emit 发射 waterfall 事件的键**，全是编译期错误。dsh 全仓用同一招：
   会话事件目录 `SessionEventMap`、`agent/*` 事件表都是插件各自声明合并进去的，
   这叫 merge-extensible。真 Cordis 里「事件的分发方式（dispatch mode）是事件公开
   契约的一部分」，用 JSDoc 的 `@mode` 标注、由生成的目录核对；本课直接把 mode
   编进类型——门控更硬，机制更少。
3. **waterfall 与 emit 的区别：观察与拦截。** `emit` 是广播：监听器按注册顺序
   **看**一眼载荷，不能改写、没有返回值。`waterfall` 是拦截链：监听器组成一条
   around-middleware 链（先注册的在外层），每个收到 `(value, next)`——**必须调
   `next()` 委托**，链才继续；**不调即短路**，这不是错误而是设计：单决策事件里
   「拥有决定权的监听器」用返回代替委托（否决），只观察/注记的监听器必须委托。
   短路只断下游、不断上游：外层观察者从 `next()` 的返回值照样能看到内层的否决。

```text
  waterfall('tool/call', 调用, 内置行为)
       │
       ▼
  audit（最外层，观察者：next(decision) 委托，记下 next 返回的最终裁决）
       │ next(decision)
       ▼
  guard（拦截者：改写 → next(改写后的值) 继续；否决 → 直接返回，不调 next）
       │ next(...)                                  │ return { veto }（短路）
       ▼                                            ▼
  内置行为（放行则执行；否决时不会到达）        链断：返回值原路回到 audit 与调用方
```

s04 的 preExecute 守卫与今天的 guard 插件是同一个思想的两种挂法：守卫是循环参数，
拦截器是插件。s08 把五件套全部搬进插件后，两者合流成 dsh 的 `tools/pre-execute`
瀑布。s06 的全部代码（循环、日志、权限、压缩、恢复）照常在场、测试照常通过
（复制前进：能力只增不减）；本课演示不请模型——拦截与协作不依赖谁发起调用，
宿主直接发起工具调用穿过拦截链，事实照旧落 s03 的日志。

## 跑起来

```sh
pnpm --filter @learn-dsh/s07-cordis dev
```

不用任何 API key，两幕 + 收束（完整输出含每步细节，此处节选）：

```text
—— 第一幕：三个插件协作运转 ——
[host/scene] 装配完成
已挂载插件：audit、counter、guard
emit agent/step { turn: 1, step: 1 } → counter 计步
读取服务 counter.steps = 1
read_file 带相对路径 → guard 改写为工作区绝对路径后执行：
  tool/call read_file({"path":"/workspace/notes/week.txt"}) → 执行：「/workspace/notes/week.txt」的内容：……
delete_file 缺 force → guard 否决（不调 next()，链短路）：
  tool/call delete_file({"path":"/tmp/old.log"}) → 否决回喂：删除必须显式传 force: true（s04 的规矩，现在是插件拦截器）

—— 第二幕：卸载 counter 插件 ——
已挂载插件：audit、guard（counter 的效果已全部回滚）
emit agent/step { turn: 1, step: 3 } → 无人计步：
读取服务 get("counter")：没有叫 "counter" 的服务（当前服务：无）
其余插件不受影响——再走一次拦截链：
  tool/call read_file({"path":"/workspace/readme.md"}) → 执行：……

—— 收束：账本与留痕 ——
SessionLog 共 8 个事件：
  turn 1 start / tool/call 与 tool/result 三对配对（否决也是 tool/result）/ turn 1 end
auditTrail（注册即效果、卸载即逆序回滚的可观测面）：
  audit: mounted
  counter: mounted（service("counter") + on("agent/step")）
  audit: read_file(…) → 放行
  audit: delete_file(…) → 否决
  counter: unmounted
  audit: read_file(…) → 放行
```

本课新增两个文件、重写一个，建议按这个顺序读：

1. `src/cordis.ts` —— 本课主角，迷你 Cordis 全部：`Ctx`（effect/on/service/get/
   emit/waterfall/mount，文件头有与真 Cordis 逐机制的对应表）、`EventMap`/
   `ServiceMap`（merge-extensible 目录）、`EmitEvent`/`WaterfallEvent`（把分发
   方式编进类型的幻影描述）。
2. `src/index.ts` —— 三个插件 + 宿主：audit（可观测 effect + 最外层瀑布观察者）、
   counter（贡献服务 + 监听事件，本课的卸载对象）、guard（waterfall 拦截器：
   改写/否决/透传三条路径）；宿主只剩「驱动」——发起 emit 与 waterfall，按裁决
   执行并落账。文件顶部的 `declare module './cordis.js'` 是使用者侧目录扩展示范。
3. `src/cordis.test.ts` —— 语义的精确边界：effect 逆序且只回滚自己的、提前回滚
   单次有效、apply 抛错半装不留、级联卸载、waterfall 短路（专门用例：后续监听器
   与内置行为都不执行）、外层观察者能看到内层否决、声明合并的键收发一致、服务
   注销后读取响亮报错（取舍写在 `get()` 的 JSDoc：真 Cordis 的 `ctx.get` 返回
   undefined 配合 inject 等待机制；本课没有 inject，静默 undefined 会把装配错误
   推迟到远处，按「misconfiguration fails loud」当场报）。

改两个地方感受一下：

- 把 `src/index.ts` 里 audit 插件的 `const outcome = next(decision)` 注释掉，改成
  直接 `return decision`——audit 在最外层，它在第一环就断了链：guard 的改写与
  否决、链尾的内置行为全部不再发生，`delete_file` 会真的执行、相对路径不再补全，
  而 auditTrail 里三次调用都只剩 audit 自己那一行。再改回来，观察链在谁手里断、
  断了之后谁还能看到结果（对照测试「外层观察者从 next() 的返回值看到内层的
  否决」）；
- 给 `EventMap` 加你自己的事件：在 `src/index.ts` 的 `declare module` 块里加
  `'host/bell': EmitEvent<{ ring: number }>`，再写 `ctx.on('host/bell', …)` 与
  `ctx.emit('host/bell', { ring: 1 })`——`cordis.ts` 一个字都不用改，字段拼错
  （`{ rng: 1 }`）编辑器立刻标红；试试加一个 `WaterfallEvent` 键，它会自动被
  `emit` 拒绝、只接受 `waterfall`。

## 看真码（进阶导读）

真 Cordis vendored 在 `vendor/cordis/`（清单与同步流程见
[vendor/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md)），
入门读 [docs/cordis-primer.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)：
五个思想 + 分发模式表 + waterfall 语义，一页纸。对照本课迷你版，值得看的差距：

- [vendor/cordis/src/context.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/context.ts)
  的 `Context` 是**代理**：属性读取走服务解析层（[reflect.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/reflect.ts)
  的 handler），服务就是 `ctx.tools`、`ctx.llm` 这样的属性；`extend()`/`isolate()`/
  `intercept()` 派生带独立服务域与拦截配置的子上下文。本课是平的类 + 显式
  `service()/get()`，没有 scope——多租户与按插件注入配置是那三个方法的用途。
- [vendor/cordis/src/fiber.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/fiber.ts)
  的 `Fiber` 是插件运行时实例：`effect()` 收集清理（`Effect` 类型允许 setup 返回
  Promise 或**可迭代的一串**清理函数，清理可异步、卸载会等待）；`FiberState`
  六态生命周期（PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING）撑起依赖等待、
  热重载（`restart()`/`update()` 先过 `internal/update` 瀑布，可否决）与配置校验
  （`ValidationError`）。本课把这一整套折叠成「一个作用域数组 + LIFO 回滚 +
  apply 抛错即回滚」。
- [vendor/cordis/src/events.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/events.ts)
  的 `EventsService`：五种分发模式——`emit`（同步观察）、`waterfall`（同步
  拦截链，`cbs.shift() ?? inner` 就是本课 `dispatch(index)` 的原型）、`parallel`
  （并发等全部）、`serial`（顺序等首个 bail）、`bail`（同步取首个 bail）。
  `on()` 的注册走 `fiber.effect()`（`register()` 方法），与本课 `on()` 的实现
  同构。模式是事件的公开契约，用 `@mode` 标注、由生成目录核对——本课把它编进
  `EmitEvent`/`WaterfallEvent` 的类型。
- [vendor/cordis/src/registry.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/registry.ts)
  的 `Plugin`：函数/类/对象三形态，`inject` 声明服务依赖（**依赖不齐插件不加载**，
  服务注销时依赖它的插件自动卸载、服务回来再加载——这就是真版不需要「get 报错」
  的原因），`Config` 声明校验 schema。本课只收对象形态、无 inject，所以服务读取
  选择响亮报错。
- [vendor/cordis/src/service.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/service.ts)
  的 `Service` 基类：构造即 `ctx.reflect.provide(name, this)`，随 fiber 注销；
  callable 服务（如 `ctx.logger(name)`）与拦截配置合并（`resolveConfig`）都在
  这层。对应本课 `service()` 的两行实现。
- dsh 的实战用法：[packages/core/session/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/types.ts)
  的 `SessionEventMap`——s03 那六个会话事件在真仓里的家，各能力插件（如
  compaction 的 `compaction/*` 四事件）各自声明合并进去；
  [packages/core/agent/src/runtime-types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/runtime-types.ts)
  的 `agent/pre-step`、`agent/request`、`agent/request-error`——`@mode waterfall`
  的拦截点，s06 提过的 compaction step-pressure 就挂在 `agent/pre-step` 上。
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：scope 隔离与按插件配置拦截
（extend/isolate/intercept）、异步清理与热重载（Fiber 状态机与 `internal/update`
否决）、依赖等待（inject）、parallel/serial/bail 分发——以及最重要的一件事：
**五件套怎么真的搬进插件**（s08）。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 上下文 | context / ctx | 插件的注册面与服务仓库；真版是 Proxy + scope |
| 效果 / 可逆效果 | (reversible) effect | 注册即执行；setup 返回清理函数 |
| 清理函数 | disposer | 单次有效；卸载时逆序执行 |
| 挂载 / 卸载 | mount / unmount | 真版 `ctx.plugin()` → Fiber，卸载即 dispose |
| 纤程 | fiber | 插件运行时实例；六态生命周期状态机 |
| 声明合并 | declaration merging | `declare module` 往 interface 加键 |
| 可合并扩展 | merge-extensible | 模块内外都能加键，类型全覆盖 |
| 事件目录 | event map | 本课 EventMap；dsh 的 SessionEventMap 同机制 |
| 分发方式 | dispatch mode | emit / waterfall / parallel / serial / bail |
| 瀑布 / 拦截链 | waterfall | around-middleware；必须 `next()` 委托 |
| 短路 / 否决 | short-circuit / veto | 不调 next()；单决策事件的设计语义 |
| 服务贡献 | provide / service | 真 Cordis：`ctx.provide()` 与 Service 基类 |
| 服务消费 / 依赖声明 | inject | 真 Cordis 声明依赖并等待；本课用 get() 显式读 |
| 作用域 | scope | 真 Context 的 extend/isolate/intercept 子上下文 |
| 幻影类型 | phantom type | EmitEvent/WaterfallEvent：只存在于类型层 |
