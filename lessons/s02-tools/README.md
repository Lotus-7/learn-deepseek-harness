# s02 · 工具：schema + 注册表 + 守卫执行管线

> 工具不是裸函数：schema 给模型看，注册表管名册，执行走「校验 → 守卫 → 执行 → 留痕」；失败也回喂模型。

## 为什么

s01 的循环已经能让模型「做事」，但工具执行是裸的：`tools.find()` 找到就 `execute`。三个隐患：

1. **名字没人管**。数组里塞两个同名工具不报错，find 只拿第一个；调一个不存在的名字，只得到一条小错误。
2. **参数没人验**。模型给的参数直接进 execute——`add({ a: '两' })` 会算出 `NaN`，错误被吞掉而不是被发现。
3. **执行没有拦截点**。想在删文件前问一句「确定吗」，没有地方挂。

本课在执行处引入一条**守卫执行管线**，在它前面放一张**注册表**：

```text
  模型的 tool_call
       │
  ① 参数校验（required + type）──失败──┐
       │ 通过                          ▼
  ② preExecute 守卫（可否决）──否决──► role:'tool' 结果消息
       │ 放行                        （错误说明回喂模型，
  ③ execute ───────抛错───────────►   模型可修正重试）
       │ 正常返回
  ④ postExecute 留痕（记录每次调用）
       │
       ▼
  role:'tool' 结果消息 ──► 回到模型
```

关键的设计决定在失败语义：**校验失败、守卫否决、执行抛错都不是进程崩溃**，它们成为
`role:'tool'` 的结果消息回喂模型。对模型来说，错误和正常结果一样是输入：看得到、能修正、
可重试。注册表则把「有哪些工具、叫什么名字」变成运行时名册：重名注册当场抛错，未知名得到
响亮错误，`schemas()` 把名册投影成模型请求里的工具列表（execute 函数不出现在请求里）。

## 跑起来

```sh
pnpm --filter @learn-dsh/s02-tools dev
```

不用任何 API key：`shared/mock-model` 回放一段剧本。模型第一次用坏参数调 `add`（a 传成了
字符串），收到校验错误后修正重试；再调 `delete_file` 没带 `force`，被守卫否决，补上
`force` 重试成功。预期输出：

```text
[user] 帮我算 2 + 3，然后删掉 a.txt
[assistant] 请求工具 add
[tool] 工具结果：参数校验失败：参数 a 应为 integer，实际是 string（"两"）
[assistant] 请求工具 add
[tool] 工具结果：5
[assistant] 请求工具 delete_file
[tool] 工具结果：守卫否决：delete_file 需要 force: true 才能执行，请确认后带上该参数重试
[assistant] 请求工具 delete_file
[tool] 工具结果：已删除 a.txt
[assistant] 2 + 3 = 5，a.txt 已删除。参数不合规、被守卫拦下都不是事故：错误文本会回到我这里，修正后重试即可。
```

本课在 s01 的 src/ 上叠加出五个源文件，建议按这个顺序读：

1. `src/registry.ts` —— `ToolRegistry`：register 重名抛错、lookup 未知名响亮报错、
   `schemas()` 只投影模型可见字段。
2. `src/pipeline.ts` —— 本课主角 `executeToolCall`：`validateArguments` 做 required +
   type 的轻量 JSON-Schema 检查；preExecute 守卫数组逐个询问，返回原因即否决；execute；
   postExecute 钩子留痕。四种失败（未知名、参数不是合法 JSON、校验不过、守卫否决）
   都物化成 tool 结果文本，不崩进程。
3. `src/agent.ts` —— `runLoop` 改为接收 registry；循环节奏没变，只是执行入口从
   「裸 find + execute」换成管线。
4. `src/index.ts` —— 剧本与 `requireForce` 守卫的挂载方式：守卫是执行处的策略，
   不写进工具定义。
5. `src/tools.ts` —— s01 带来的 echo/add，加上 `delete_file`：注意它只是个普通工具，
   「必须 force」这件事在它的定义里不存在。

改两个地方感受一下：

- 把剧本第一步的 `{ a: '两', b: 3 }` 改成 `{ a: 2.5, b: 3 }` 重跑：校验错误变成
  「参数 a 应为 integer，实际是 number（2.5）」——number 与 integer 的区别也会被抓住；
- 把 `src/index.ts` 里传给 runLoop 的 `preExecute: [requireForce]` 一行删掉重跑：
  没挂守卫的 delete_file 直接放行。守卫是策略，不挂就没有——这也是 s04 权限课的挂法。

## 看真码（进阶导读）

如果你已经写过 tool-use 循环，直接看 dsh 在这一层多做了什么：

- [packages/core/tools/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/index.ts)
  的 `ToolRuntime`：本课「注册表 + 管线」的生产版合体。注册表是 **scoped** 的——全局一层
  加每个 agent scope 一层，scoped 注册 shadow 全局同名工具，`restrict()` 还能按 scope 过滤
  可见集合（本课是一张平表）。执行暴露为四个 `tools/*` 事件——前三个是瀑布，`tools/result`
  是同步观察（emit，只读）：`tools/pre-execute`
  （allow/deny/ask；ask 走审批服务，没有审批通道就降级为 deny）、`tools/execute`
  （around 包装，超时/重试/指标挂这里）、`tools/post-execute`（accept/block/替换内容/
  附加上下文）、`tools/result`（观察冻结的最终结果）；另有 `ctx.tools.guard()` 注册
  只能否决、不能推翻别人否决的单调守卫。本课的 preExecute/postExecute 钩子数组是它们的
  直系简化版。失败语义与本课相同：校验失败、守卫否决、工具抛错都物化成 `isError` 的
  结果（文本 `Error: ...`）回喂模型。
- [packages/core/tools/src/schema.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/schema.ts)：
  dsh 不让作者手写 JSON Schema。`ParameterSchemaSpec` DSL（如
  `{ path: { type: 'string', required: true } }`）编译成强制的 JSON Schema 子集，
  `defineTool` 顺带推断出 TS 参数类型（`InferArgs`），execute 前校验、违规抛
  `ToolArgsError`；连工具的 output 都有 schema 与 render 投影，返回值同样被校验。
  本课只查 required 与顶层 type。
- [packages/core/tools/src/invariant.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/invariant.ts)：
  用会话事件断言每条调用真的按 pre → execute → post 顺序走——管线不只是文档约定。
- [docs/architecture.md 的 Turn flow 一节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#turn-flow)：
  `tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*`
  在完整事件序列里的位置；
- [docs/tool-execution-pipeline.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md)：
  整条管线的流程图；
- [docs/cookbook/adding-a-tool.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)：
  写一个 dsh 工具要遵守的契约清单；
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：守卫之外要不要「问用户」——ask 决策与审批服务
（s04）；注册表要不要按 agent 隔离出私有工具集（s11 子代理）；工具执行中的取消与超时
怎么进同一条管线（s05）。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 工具注册表 | tool registry | dsh 里是 ToolRuntime 服务（ctx.tools） |
| 执行管线 | execution pipeline | 校验 → pre → execute → post |
| 守卫 | guard | dsh 里特指只能否决的单调守卫；本课泛指 preExecute 钩子 |
| 否决 | veto / deny | 否决原因作为 tool 结果回喂模型 |
| 参数校验 | argument validation | dsh 用强制的 JSON Schema 子集，不手写裸 schema |
| 留痕 | call recording | postExecute 钩子记录每次调用（含失败） |
| 瀑布 | waterfall | dsh 监听链形式，监听器必须调 `next()` 交棒 |
