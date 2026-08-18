# s01 · 最小循环：一个能干活的 agent

> 最小可用的 agent = 调模型、跑工具、喂结果的循环。

本课是整个系列的起点，也是每一课的形态样板：**为什么 → 跑起来 → 看真码**。

## 为什么

让模型「干活」的障碍不是回答问题，是**做事**：读文件、算数、改代码。
模型本身只能生成文字，于是所有 agent harness 的核心都是同一个循环：

```text
      ┌─────────────────────────────────┐
      │                                 ▼
  用户输入 ──► 模型 ──► 要调工具？──是──► 执行工具 ──► 结果贴回对话
                    │                        （回到模型）
                    否
                    ▼
                最终回答，循环结束
```

模型自己决定「下一步调什么工具」；循环负责执行并把结果喂回去。
没有这个循环，模型只能「说出」答案；有了它，模型才能「做出」答案。

dsh 把这个循环做成了生产级：`packages/core/agent-loop` 里同样的结构被拆成
turn（一轮对话）与 step（一次模型请求）两级，每一步都会向会话日志写入
durable 事件，并暴露插件可拦截的事件——但那些是后面的课。今天先写最小的。

## 跑起来

```sh
pnpm --filter @learn-dsh/s01-min-loop dev
```

不用任何 API key：`shared/mock-model` 回放一段剧本。剧本里模型先要调
`add(2, 3)`，再要 `echo` 复读结果，最后给出回答。预期输出：

```text
[user] 帮我算 2 + 3
[assistant] 请求工具 add
[tool] 工具结果：5
[assistant] 请求工具 echo
[tool] 工具结果：算出来了：5
[assistant] 2 + 3 = 5。这是最小循环的一次完整运转。
```

代码只有两个文件，建议按这个顺序读：

1. `src/tools.ts` —— `defineTool` 把「给模型看的 schema」和「给循环执行的
   `execute`」绑成一个单元。工具对模型来说就是名字 + 描述 + 参数 schema。
2. `src/agent.ts` —— `runLoop` 是本课全部内容，不到 40 行：
   - 组装 messages（先是那条用户输入）与工具 schema 列表；
   - 每步调模型，`finishReason` 是 `tool_calls` 就执行每个调用、
     把结果作为 `role: 'tool'` 消息贴回去；
   - 否则返回整段对话，最后一条就是回答；
   - `maxSteps` 是保险丝：模型若无限要工具，循环在 20 步（可配）后中止。

改两个地方感受一下：

- 把剧本里 `add` 的参数改成 `{ a: 40, b: 2 }`，重跑，观察第一条工具结果；
- 把 `maxSteps` 传成 `1`，看保险丝怎么断（测试 `agent.test.ts` 第三条
  用例演示的正是这个行为）。

## 看真码（进阶导读）

如果你已经写过 tool-use 循环，直接看 dsh 在这一层多做了什么：

- [packages/core/agent-loop](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-loop)
  的 `agent.ts`：本课的循环在那里被拆成 `turn/*` 与 `step/*` 事件，每步
  请求前有 `agent/pre-step` 瀑布可以改写或拒绝本次输入，模型流式响应
  逐块落为 `assistant/chunk` 会话事件；
- [docs/architecture.md 的 Turn flow 一节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#turn-flow)：
  完整事件序列图；
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：工具执行要不要守卫与审批（s04）、
对话历史怎么持久化与回放（s03）、取消一个正在跑的循环意味着什么（s05）。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 循环 / 驱动器 | agent loop / driver | dsh 里叫 driver，实现 `Agent` 接口 |
| 轮 | turn | 零或多步；一次用户意图的完整生命周期 |
| 步 | step | 一次模型请求 + 它调用的工具 |
| 工具调用 | tool call | 模型输出的结构化请求，循环负责执行 |
| 剧本模型 | mock model | 回放预录响应，测试与教学不依赖真模型 |
