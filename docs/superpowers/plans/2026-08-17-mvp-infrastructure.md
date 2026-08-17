# learn-deepseek-harness MVP 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建学习网站的完整基础设施（monorepo、mock 模型、元数据流水线、VitePress 站点、CI），并用 s01「最小循环」一课完整打样，验证从课程代码到时间线页的全链路。

**Architecture:** pnpm workspace monorepo。`lessons/` 下每课一个自包含包（唯一共享依赖是自家的 mock 模型适配器），`site/` 是 VitePress 站点。课程文稿与代码同目录（README.md + lesson.yaml 为唯一事实源），`scripts/sync-lessons.ts` 统计行数/工具数写回 lesson.yaml，并把文稿投影成站点页面与 `site/lessons-meta.json`；时间线页读该 JSON 渲染。

**Tech Stack:** TypeScript（ESM，无构建步骤，tsx 运行）、vitest、VitePress 1.6、GitHub Actions + Pages。

**范围（明确不做的）:** s02–s16 的课程内容不在本计划。它们按 s01 的目录与文稿模式，在学习环（读 dsh 源码 → 写示例 → 写文稿 → 构建验证）中逐课追加。中英双语、评论、在线沙盒等见设计文档 YAGNI 清单。

## Global Constraints

- 全仓 ESM（`"type": "module"`）；Node `>=22`；包管理 pnpm workspace。
- 所有测试与示例不依赖 `DEEPSEEK_API_KEY`（mock 模型回放）。
- 课程包运行时零第三方依赖；仓库级工具链只在 root devDependencies（tsx、vitest、yaml、@types/node）。
- 课程内容纯中文，专业术语保留英文（如 capability seam、turn、step）。
- dsh 源码链接统一指向 `https://github.com/deepseek-ai/deepseek-harness`（master 分支——上游默认分支，无 main），并在 lesson.yaml 的 `verifiedDshVersion` 标注验证过的版本；当前为 `0.1.0-rc.5`。
- 文件以恰好一个换行符结尾。
- 依赖版本以本计划核验过的为准：vitepress `^1.6.4`、vitest `^4.1.10`、tsx `^4.23.12`、yaml `^2.9.0`、@types/node `^24.3.0`。
- 仓库名与 GitHub 地址：`Lotus-7/learn-deepseek-harness`（本地路径 `/Users/lotus-7/Documents/GitHub/learn-deepseek-harness`）。

---

### Task 1: 仓库基座（workspace + vitest + tsconfig）

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Interfaces:**
- Produces: root scripts `pnpm test`（vitest run）、`pnpm run sync`（Task 5 填充）、`pnpm site:dev` / `pnpm site:build`（Task 6 填充）；workspace 包约定 `lessons/*`、`lessons/shared/*`、`site`。

- [ ] **Step 1: 写 pnpm-workspace.yaml**

```yaml
packages:
  - lessons/*
  - lessons/shared/*
  - site
```

- [ ] **Step 2: 写根 package.json**

```json
{
  "name": "learn-deepseek-harness",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "sync": "tsx scripts/sync-lessons.ts",
    "test": "vitest run",
    "site:dev": "pnpm run sync && pnpm --filter @learn-dsh/site dev",
    "site:build": "pnpm run sync && pnpm --filter @learn-dsh/site build",
    "site:preview": "pnpm --filter @learn-dsh/site preview"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "tsx": "^4.23.12",
    "vitest": "^4.1.10",
    "yaml": "^2.9.0"
  }
}
```

- [ ] **Step 3: 写 tsconfig.json（仅编辑器与类型检查用，全仓无构建步骤）**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"],
    "verbatimModuleSyntax": true
  },
  "include": ["lessons", "scripts"]
}
```

- [ ] **Step 4: 写 .gitignore**

```
node_modules/
site/.vitepress/cache/
site/.vitepress/dist/
site/lessons/
site/lessons-meta.json
```

（`site/lessons/` 与 `site/lessons-meta.json` 是 Task 5 投影脚本的生成物，不入库。）

- [ ] **Step 5: 安装并验证空测试可跑**

Run: `pnpm install && pnpm exec vitest run --passWithNoTests`
Expected: 安装成功；vitest 输出 no test files found 且退出码 0。

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.json .gitignore pnpm-lock.yaml
git commit -m "chore: 仓库基座（pnpm workspace + vitest + tsconfig）"
```

---

### Task 2: mock 模型适配器（TDD）

**Files:**
- Create: `lessons/shared/mock-model/package.json`
- Create: `lessons/shared/mock-model/src/types.ts`
- Create: `lessons/shared/mock-model/src/index.ts`
- Test: `lessons/shared/mock-model/src/index.test.ts`

**Interfaces:**
- Produces（后续所有课的模型词汇，s01 直接消费）:
  - 类型 `ChatMessage { role: 'system'|'user'|'assistant'|'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }`
  - 类型 `ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }`
  - 类型 `ToolSchema { name: string; description: string; parameters: Record<string, unknown> }`
  - 类型 `ModelResponse { message: ChatMessage; finishReason: 'stop' | 'tool_calls' }`
  - 类型 `Model = (messages: ChatMessage[], tools: ToolSchema[]) => Promise<ModelResponse>`
  - `createMockModel(script: ModelResponse[]): MockModel`，其中 `MockModel extends Model` 且带 `readonly calls: ChatMessage[][]`
  - `toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall`

- [ ] **Step 1: 写包声明**

`lessons/shared/mock-model/package.json`：

```json
{
  "name": "@learn-dsh/mock-model",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

（无构建步骤：直接导出 TS 源，消费方 tsx/vitest 都能转译。）

- [ ] **Step 2: 写失败测试**

`lessons/shared/mock-model/src/index.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall } from './index'

const tools = [{ name: 'add', description: '', parameters: {} }]

describe('createMockModel', () => {
  it('按顺序回放脚本响应', async () => {
    const model = createMockModel([
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'add', { a: 1 })] },
        finishReason: 'tool_calls',
      },
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
    ])
    const first = await model([{ role: 'user', content: 'hi' }], tools)
    expect(first.finishReason).toBe('tool_calls')
    const second = await model([{ role: 'user', content: 'hi' }, first.message], tools)
    expect(second.message.content).toBe('done')
  })

  it('记录每次请求的 messages 快照', async () => {
    const model = createMockModel([{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }])
    await model([{ role: 'user', content: 'q' }], [])
    expect(model.calls).toEqual([[{ role: 'user', content: 'q' }]])
  })

  it('脚本耗尽后抛出可诊断的错误', async () => {
    const model = createMockModel([])
    await expect(model([{ role: 'user', content: 'q' }], [])).rejects.toThrow(/耗尽/)
  })
})

describe('toolCall', () => {
  it('构造 function 调用并把参数序列化为 JSON 字符串', () => {
    expect(toolCall('id1', 'add', { a: 2, b: 3 })).toEqual({
      id: 'id1',
      type: 'function',
      function: { name: 'add', arguments: '{"a":2,"b":3}' },
    })
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm install && pnpm test`
Expected: FAIL，报找不到 `./index` 模块。

- [ ] **Step 4: 写类型与实现**

`lessons/shared/mock-model/src/types.ts`：

```ts
/** 模型可见的一条消息。s01 只用到 user/assistant/tool 三个角色，system 留给后续课程。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

/** 模型发起的一次工具调用；arguments 是 JSON 字符串（与主流 LLM API 一致）。 */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** 注册时提供给模型的工具描述（JSON Schema 形态）。 */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 一次模型响应：给出的消息 + 为什么结束这次生成。 */
export interface ModelResponse {
  message: ChatMessage
  finishReason: 'stop' | 'tool_calls'
}

/** 模型适配器。dsh 里对应挂在 ctx.llm 后面的 provider；每课可替换实现。 */
export type Model = (messages: ChatMessage[], tools: ToolSchema[]) => Promise<ModelResponse>
```

`lessons/shared/mock-model/src/index.ts`：

```ts
import type { ChatMessage, Model, ModelResponse, ToolCall } from './types'

export * from './types'

export interface MockModel extends Model {
  /** 每次请求收到的 messages 快照，供测试断言模型到底看到了什么。 */
  readonly calls: ChatMessage[][]
}

/** 构造一个 function 调用，参数自动 JSON 序列化。写课程剧本用。 */
export function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/**
 * 创建回放剧本的模型：按顺序吐出 script 里的每个响应，并记录每次请求。
 * 剧本耗尽后抛错而不是静默重复——测试挂掉时应指向剧本缺陷本身。
 */
export function createMockModel(script: ModelResponse[]): MockModel {
  const calls: ChatMessage[][] = []
  let cursor = 0
  const model = (messages: ChatMessage[]): Promise<ModelResponse> => {
    calls.push(structuredClone(messages))
    if (cursor >= script.length) {
      throw new Error(`mock 模型剧本已耗尽（共 ${script.length} 条），第 ${cursor + 1} 次调用无响应可回放`)
    }
    return Promise.resolve(script[cursor++]!)
  }
  return Object.assign(model, { calls }) as MockModel
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS（4 个用例）。

- [ ] **Step 6: Commit**

```bash
git add lessons/shared/mock-model
git commit -m "feat: mock 模型适配器——剧本回放与请求记录"
```

---

### Task 3: s01 课程代码：最小 agent 循环（TDD）

**Files:**
- Create: `lessons/s01-min-loop/package.json`
- Create: `lessons/s01-min-loop/src/tools.ts`
- Create: `lessons/s01-min-loop/src/agent.ts`
- Create: `lessons/s01-min-loop/src/index.ts`
- Test: `lessons/s01-min-loop/src/agent.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `@learn-dsh/mock-model`（`createMockModel`、`toolCall` 及四个类型）。
- Produces（s02+ 会复用这套形态）:
  - `Tool { name; description; parameters: Record<string, unknown>; execute(args: Record<string, unknown>): Promise<string> }`
  - `defineTool(tool: Tool): Tool` —— 全仓库的统计约定：`sync-lessons.ts` 以 `defineTool(` 的出现次数统计每课工具数
  - `runLoop(model: Model, tools: Tool[], userText: string, options?: { maxSteps?: number }): Promise<ChatMessage[]>` —— 返回完整对话（含工具往返），最终一条是模型的回答

- [ ] **Step 1: 写包声明**

`lessons/s01-min-loop/package.json`：

```json
{
  "name": "@learn-dsh/s01-min-loop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "tsx src/index.ts" },
  "dependencies": { "@learn-dsh/mock-model": "workspace:*" }
}
```

- [ ] **Step 2: 写失败测试**

`lessons/s01-min-loop/src/agent.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { addTool, echoTool } from './tools'

/** 与 src/index.ts 演示相同的剧本：先要两次工具，再给最终回答。 */
const script: ModelResponse[] = [
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'add', { a: 2, b: 3 })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_2', 'echo', { text: '算出来了：5' })] },
    finishReason: 'tool_calls',
  },
  { message: { role: 'assistant', content: '2 + 3 = 5。这是最小循环的一次完整运转。' }, finishReason: 'stop' },
]

describe('runLoop', () => {
  it('跑完工具往返并返回最终回答', async () => {
    const model = createMockModel(script)
    const messages = await runLoop(model, [addTool, echoTool], '帮我算 2 + 3')
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '2 + 3 = 5。这是最小循环的一次完整运转。',
    })
  })

  it('把工具结果回喂给模型', async () => {
    const model = createMockModel(script)
    await runLoop(model, [addTool, echoTool], '帮我算 2 + 3')
    expect(model.calls[1]).toContainEqual({ role: 'tool', content: '5', tool_call_id: 'call_1' })
    expect(model.calls[2]).toContainEqual({ role: 'tool', content: '算出来了：5', tool_call_id: 'call_2' })
  })

  it('模型无限要工具时按 maxSteps 中止', async () => {
    const loopStep: ModelResponse = {
      message: { role: 'assistant', content: null, tool_calls: [toolCall('c', 'echo', { text: '再来' })] },
      finishReason: 'tool_calls',
    }
    const model = createMockModel(Array.from({ length: 50 }, () => loopStep))
    await expect(runLoop(model, [echoTool], '停不下来', { maxSteps: 3 })).rejects.toThrow(/maxSteps/)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm install && pnpm test`
Expected: FAIL，报找不到 `./agent` / `./tools`。

- [ ] **Step 4: 实现 tools.ts 与 agent.ts**

`lessons/s01-min-loop/src/tools.ts`：

```ts
/** 一个工具：schema 给模型看，execute 给循环调。 */
export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

/** 课程约定：所有课都用 defineTool 定义工具，仓库统计脚本据此数出每课的工具数。 */
export function defineTool(tool: Tool): Tool {
  return tool
}

export const echoTool = defineTool({
  name: 'echo',
  description: '原样返回 text 参数，用于演示最简单的工具调用',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要复读的内容' } },
    required: ['text'],
  },
  execute: async (args) => String(args.text),
})

export const addTool = defineTool({
  name: 'add',
  description: '计算两个整数的和',
  parameters: {
    type: 'object',
    properties: { a: { type: 'integer' }, b: { type: 'integer' } },
    required: ['a', 'b'],
  },
  execute: async (args) => String(Number(args.a) + Number(args.b)),
})
```

`lessons/s01-min-loop/src/agent.ts`：

```ts
import type { ChatMessage, Model, ToolCall } from '@learn-dsh/mock-model'
import type { Tool } from './tools'

export interface RunLoopOptions {
  /** 保险丝：模型连续请求工具的步数上限，默认 20。 */
  maxSteps?: number
}

/**
 * 最小 agent 循环：把用户输入喂给模型；模型要么给出最终回答，
 * 要么请求工具——执行、把结果贴回对话、再问模型，直到得到回答。
 * dsh 对应 packages/core/agent-loop：同一个循环在那里被拆成
 * turn/step 两级，并挂上会话事件与插件扩展点。
 */
export async function runLoop(
  model: Model,
  tools: Tool[],
  userText: string,
  options: RunLoopOptions = {},
): Promise<ChatMessage[]> {
  const maxSteps = options.maxSteps ?? 20
  const messages: ChatMessage[] = [{ role: 'user', content: userText }]
  const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }))

  for (let step = 1; step <= maxSteps; step++) {
    const { message, finishReason } = await model(messages, schemas)
    messages.push(message)

    if (finishReason !== 'tool_calls' || !message.tool_calls) {
      return messages
    }
    for (const call of message.tool_calls) {
      messages.push(await executeCall(tools, call))
    }
  }
  throw new Error(`模型连续 ${maxSteps} 步都在请求工具，超出 maxSteps 上限，循环中止`)
}

async function executeCall(tools: Tool[], call: ToolCall): Promise<ChatMessage> {
  const tool = tools.find((t) => t.name === call.function.name)
  const output = tool
    ? await tool.execute(JSON.parse(call.function.arguments) as Record<string, unknown>)
    : `错误：没有叫 ${call.function.name} 的工具`
  return { role: 'tool', content: output, tool_call_id: call.id }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS（mock-model 4 个 + s01 3 个）。

- [ ] **Step 6: 写演示入口并跑通**

`lessons/s01-min-loop/src/index.ts`：

```ts
import { createMockModel, toolCall } from '@learn-dsh/mock-model'
import { runLoop } from './agent'
import { addTool, echoTool } from './tools'

// 剧本：模型先要两次工具，再给最终回答。换成真模型时，这些决定由模型自己做出。
const model = createMockModel([
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'add', { a: 2, b: 3 })] },
    finishReason: 'tool_calls',
  },
  {
    message: { role: 'assistant', content: null, tool_calls: [toolCall('call_2', 'echo', { text: '算出来了：5' })] },
    finishReason: 'tool_calls',
  },
  { message: { role: 'assistant', content: '2 + 3 = 5。这是最小循环的一次完整运转。' }, finishReason: 'stop' },
])

const messages = await runLoop(model, [addTool, echoTool], '帮我算 2 + 3')

for (const m of messages) {
  const detail =
    m.role === 'assistant' && m.tool_calls
      ? `请求工具 ${m.tool_calls.map((c) => c.function.name).join(', ')}`
      : m.role === 'tool'
        ? `工具结果：${m.content}`
        : (m.content ?? '')
  console.log(`[${m.role}] ${detail}`)
}
```

Run: `pnpm --filter @learn-dsh/s01-min-loop dev`
Expected 输出：

```
[user] 帮我算 2 + 3
[assistant] 请求工具 add
[tool] 工具结果：5
[assistant] 请求工具 echo
[tool] 工具结果：算出来了：5
[assistant] 2 + 3 = 5。这是最小循环的一次完整运转。
```

- [ ] **Step 7: Commit**

```bash
git add lessons/s01-min-loop
git commit -m "feat(s01): 最小 agent 循环——模型、工具、结果回喂"
```

---

### Task 4: s01 文稿与 lesson.yaml

**Files:**
- Create: `lessons/s01-min-loop/lesson.yaml`
- Create: `lessons/s01-min-loop/README.md`

**Interfaces:**
- Produces（Task 5 的 sync 脚本与 Task 6 的站点都按此消费）:
  - `lesson.yaml` 字段：`id`（如 `s01`）、`stage`（1–5）、`slug`（如 `min-loop`）、`title`、`idea`（一句话核心理念）、`lines`/`tools`（sync 脚本写回，初始 0）、`dsh: [{label, url}]`、`verifiedDshVersion`
  - 课程目录名 = `<id>-<slug>`（如 `s01-min-loop`），决定站点路由 `/lessons/s01-min-loop/`
  - README.md 为正文（纯 markdown，H1 开头，无 frontmatter——frontmatter 由投影脚本生成）

- [ ] **Step 1: 写 lesson.yaml**

```yaml
id: s01
stage: 1
slug: min-loop
title: 最小循环：一个能干活的 agent
idea: 最小可用的 agent = 调模型、跑工具、喂结果的循环
lines: 0
tools: 0
dsh:
  - label: packages/core/agent-loop
    url: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-loop
  - label: docs/architecture.md（Turn flow 一节）
    url: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#turn-flow
verifiedDshVersion: 0.1.0-rc.5
```

（`lines`/`tools` 初始 0，`pnpm run sync` 在 Task 5 之后写回真实统计值。）

- [ ] **Step 2: 写 README.md（课程正文）**

`lessons/s01-min-loop/README.md`：

````markdown
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
````

- [ ] **Step 3: Commit**

```bash
git add lessons/s01-min-loop/lesson.yaml lessons/s01-min-loop/README.md
git commit -m "docs(s01): 课程文稿与元数据"
```

---

### Task 5: sync-lessons 脚本（统计 + 投影，TDD）

**Files:**
- Create: `scripts/sync-lessons.ts`
- Test: `scripts/sync-lessons.test.ts`

**Interfaces:**
- Consumes: Task 4 定义的 `lesson.yaml` 字段与目录名约定。
- Produces:
  - `pnpm run sync` 一次完成两件事：① 把 `lines`（src 下非 `*.test.ts` 的 `.ts` 文件非空行数）与 `tools`（`= defineTool(` 出现次数，排除函数声明行）写回每个 `lessons/<dir>/lesson.yaml`（保留注释与字段顺序）；② 把每个 README.md 投影为 `site/lessons/<dir>/index.md`（生成 frontmatter：title 取 lesson.yaml，description 取 idea），并汇总写 `site/lessons-meta.json`
  - `lessons-meta.json` 为数组，元素字段：`id: string`、`stage: number`、`title: string`、`idea: string`、`lines: number`、`tools: number`、`dsh: { label: string; url: string }[]`、`verifiedDshVersion: string`、`href: string`（如 `/lessons/s01-min-loop/`），按 `id` 升序——Task 6 的 Timeline.vue 按此消费

- [ ] **Step 1: 写失败测试**

`scripts/sync-lessons.test.ts`：

```ts
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { countLines, countTools, syncLessons } from './sync-lessons'

const root = mkdtempSync(join(tmpdir(), 'sync-lessons-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('countLines / countTools', () => {
  it('统计非空行，忽略测试文件', async () => {
    const dir = join(root, 'fixture')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1\n\nconst b = 2\n')
    writeFileSync(join(dir, 'src', 'a.test.ts'), 'const x = 1\nconst y = 2\n')
    expect(await countLines([join(dir, 'src', 'a.ts'), join(dir, 'src', 'a.test.ts')])).toBe(2)
  })

  it('数 defineTool 的调用次数，排除函数声明行', () => {
    const dir = join(root, 'fixture2')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'tools.ts')
    writeFileSync(file, 'export function defineTool(t) { return t }\nconst a = defineTool({})\nconst b = defineTool({})\n')
    expect(countTools([file])).toBe(2)
  })
})

describe('syncLessons', () => {
  it('写回统计值并产出站点投影', async () => {
    const lessonDir = join(root, 'lessons', 's01-min-loop')
    mkdirSync(join(lessonDir, 'src'), { recursive: true })
    writeFileSync(
      join(lessonDir, 'lesson.yaml'),
      [
        'id: s01',
        'stage: 1',
        'slug: min-loop',
        'title: 最小循环',
        'idea: 调模型、跑工具、喂结果',
        'lines: 0',
        'tools: 0',
        'dsh:',
        '  - label: packages/core/agent-loop',
        '    url: https://example.com/agent-loop',
        'verifiedDshVersion: 0.1.0-rc.5',
        '',
      ].join('\n'),
    )
    writeFileSync(join(lessonDir, 'README.md'), '# 最小循环\n\n正文。\n')
    writeFileSync(join(lessonDir, 'src', 'main.ts'), 'const t = defineTool({})\n\nconst x = 1\n')

    await syncLessons(root)

    const yamlOut = readFileSync(join(lessonDir, 'lesson.yaml'), 'utf8')
    expect(yamlOut).toContain('lines: 2')
    expect(yamlOut).toContain('tools: 1')

    const page = readFileSync(join(root, 'site', 'lessons', 's01-min-loop', 'index.md'), 'utf8')
    expect(page).toContain('title: 最小循环')
    expect(page).toContain('description: 调模型、跑工具、喂结果')
    expect(page).toContain('# 最小循环')

    const meta = JSON.parse(readFileSync(join(root, 'site', 'lessons-meta.json'), 'utf8')) as Array<{
      id: string
      href: string
    }>
    expect(meta).toEqual([
      expect.objectContaining({ id: 's01', href: '/lessons/s01-min-loop/', lines: 2, tools: 1 }),
    ])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL，报找不到 `./sync-lessons`。

- [ ] **Step 3: 实现 scripts/sync-lessons.ts**

```ts
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

/** 统计 files 里非 *.test.ts 文件的非空行数。行数是教学叙事指标，不做注释剔除。 */
export async function countLines(files: string[]): Promise<number> {
  const { isFile } = await import('node:fs/promises')
  let lines = 0
  for (const file of files) {
    if (file.endsWith('.test.ts') || !(await isFile(file))) continue
    lines += readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '').length
  }
  return lines
}

/** 数 files 里 = defineTool( 出现次数（只数调用赋值，排除函数声明行——课程定义工具的统一约定）。 */
export function countTools(files: string[]): number {
  return files.reduce(
    (n, file) => n + (readFileSync(file, 'utf8').match(/= defineTool\(/g)?.length ?? 0),
    0,
  )
}

export interface LessonMeta {
  id: string
  stage: number
  title: string
  idea: string
  lines: number
  tools: number
  dsh: { label: string; url: string }[]
  verifiedDshVersion: string
  href: string
}

/**
 * 全仓同步：统计每课行数/工具数写回 lesson.yaml（yaml Document API 保留注释），
 * 再把 README 投影为站点页面并汇总 lessons-meta.json。幂等，可反复运行。
 */
export async function syncLessons(root = process.cwd()): Promise<void> {
  const lessonsRoot = join(root, 'lessons')
  const meta: LessonMeta[] = []

  for (const dir of readdirSync(lessonsRoot).sort()) {
    const lessonDir = join(lessonsRoot, dir)
    const yamlPath = join(lessonDir, 'lesson.yaml')
    const srcDir = join(lessonDir, 'src')
    let srcFiles: string[] = []
    try {
      srcFiles = readdirSync(srcDir).map((f) => join(srcDir, f))
    } catch {
      // 没有 src 的目录（如 shared/）不是课程，跳过统计但也不投影。
      continue
    }
    try {
      readFileSync(yamlPath)
    } catch {
      continue
    }

    const doc = parseDocument(readFileSync(yamlPath, 'utf8'))
    const lines = await countLines(srcFiles)
    const tools = countTools(srcFiles)
    doc.set('lines', lines)
    doc.set('tools', tools)
    writeFileSync(yamlPath, String(doc))

    const readme = readFileSync(join(lessonDir, 'README.md'), 'utf8')
    const pageDir = join(root, 'site', 'lessons', dir)
    mkdirSync(pageDir, { recursive: true })
    writeFileSync(
      join(pageDir, 'index.md'),
      `---\ntitle: ${doc.get('title')}\ndescription: ${doc.get('idea')}\n---\n\n${readme}`,
    )

    meta.push({
      id: String(doc.get('id')),
      stage: Number(doc.get('stage')),
      title: String(doc.get('title')),
      idea: String(doc.get('idea')),
      lines,
      tools,
      dsh: (doc.get('dsh') as { label: string; url: string }[]) ?? [],
      verifiedDshVersion: String(doc.get('verifiedDshVersion')),
      href: `/lessons/${dir}/`,
    })
  }

  meta.sort((a, b) => a.id.localeCompare(b.id))
  mkdirSync(join(root, 'site'), { recursive: true })
  writeFileSync(join(root, 'site', 'lessons-meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
}

// 直接运行时（pnpm run sync）执行；被测试导入时不执行。
if (process.argv[1]?.endsWith('sync-lessons.ts')) {
  await syncLessons()
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS（含 sync 的 3 个用例）。

- [ ] **Step 5: 对真实仓库跑一次并检查产物**

Run: `pnpm run sync && git diff --stat && ls site/lessons/s01-min-loop/ site/lessons-meta.json`
Expected: `lessons/s01-min-loop/lesson.yaml` 的 lines/tools 被写回真实统计；生成 `site/lessons/s01-min-loop/index.md` 与 `site/lessons-meta.json`（均被 .gitignore 排除，`git status` 不显示它们）。

- [ ] **Step 6: Commit**

```bash
git add scripts/sync-lessons.ts scripts/sync-lessons.test.ts lessons/s01-min-loop/lesson.yaml
git commit -m "feat: sync-lessons——统计课程元数据并投影站点页面"
```

---

### Task 6: VitePress 站点

**Files:**
- Create: `site/package.json`
- Create: `site/.vitepress/config.ts`
- Create: `site/.vitepress/theme/Timeline.vue`
- Create: `site/index.md`
- Create: `site/timeline.md`
- Create: `site/glossary.md`
- Create: `site/about.md`

**Interfaces:**
- Consumes: Task 5 生成的 `site/lessons-meta.json`（字段见 Task 5 Produces）与 `site/lessons/<dir>/index.md`。
- Produces: 可 `pnpm site:dev` 本地预览、`pnpm site:build` 产出 `site/.vitepress/dist/` 的站点。

- [ ] **Step 1: 写 site/package.json**

```json
{
  "name": "@learn-dsh/site",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vitepress dev",
    "build": "vitepress build",
    "preview": "vitepress preview"
  },
  "devDependencies": { "vitepress": "^1.6.4" }
}
```

- [ ] **Step 2: 写 site/.vitepress/config.ts**

```ts
import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Learn DeepSeek Harness',
  description:
    '从最小循环到生产级 agent harness：概念演进 + 可运行示例 + deepseek-harness 源码导读',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '时间线', link: '/timeline/' },
      { text: '术语表', link: '/glossary/' },
      { text: '关于', link: '/about/' },
      {
        text: 'GitHub',
        link: 'https://github.com/Lotus-7/learn-deepseek-harness',
      },
      {
        text: 'deepseek-harness',
        link: 'https://github.com/deepseek-ai/deepseek-harness',
      },
    ],
    // 新增课程时在 items 里加一行；sync 脚本不改这里，保持显式。
    sidebar: {
      '/lessons/': {
        text: '课程',
        items: [{ text: 's01 最小循环', link: '/lessons/s01-min-loop/' }],
      },
    },
    outline: { level: [2, 3] },
  },
})
```

- [ ] **Step 3: 写 Timeline.vue（时间线卡片 + 代码量增长条）**

`site/.vitepress/theme/Timeline.vue`：

```vue
<script setup lang="ts">
import lessons from '../../lessons-meta.json'

interface LessonMeta {
  id: string
  stage: number
  title: string
  idea: string
  lines: number
  tools: number
  dsh: { label: string; url: string }[]
  verifiedDshVersion: string
  href: string
}

const stages: { id: number; name: string; note: string }[] = [
  { id: 1, name: '阶段一 · 最小循环', note: '纯手写，零框架' },
  { id: 2, name: '阶段二 · 可控与可恢复', note: '权限、恢复、压缩' },
  { id: 3, name: '阶段三 · 插件化（Cordis 之道）', note: '一切皆插件' },
  { id: 4, name: '阶段四 · 生产化能力', note: '沙箱、子代理、持久化' },
  { id: 5, name: '阶段五 · 组装与桥接', note: '通向你自己的业务' },
]

const byStage = (stage: number): LessonMeta[] =>
  (lessons as LessonMeta[]).filter((l) => l.stage === stage)

const maxLines = Math.max(...(lessons as LessonMeta[]).map((l) => l.lines), 1)
</script>

<template>
  <section v-for="stage in stages" :key="stage.id" class="stage">
    <h2 :id="`stage-${stage.id}`">
      {{ stage.name }}
      <span class="note">{{ stage.note }}</span>
    </h2>
    <div class="cards">
      <a v-for="lesson in byStage(stage.id)" :key="lesson.id" :href="lesson.href" class="card">
        <div class="card-head">
          <span class="id">{{ lesson.id }}</span>
          <span class="title">{{ lesson.title }}</span>
        </div>
        <p class="idea">{{ lesson.idea }}</p>
        <div class="badges">
          <span class="badge">{{ lesson.lines }} 行</span>
          <span class="badge">{{ lesson.tools }} 个工具</span>
        </div>
        <div class="dsh">
          <a
            v-for="d in lesson.dsh"
            :key="d.url"
            :href="d.url"
            class="chip"
            @click.stop
            rel="noopener"
          >dsh · {{ d.label }}</a>
        </div>
        <div class="bar" :style="{ width: `${Math.max((lesson.lines / maxLines) * 100, 4)}%` }" />
      </a>
    </div>
  </section>

  <section class="growth">
    <h2 id="growth">代码量增长</h2>
    <p class="note">课程示例随阶段长大；每根条是当课 src 的非空行数。</p>
    <div v-for="lesson in lessons" :key="lesson.id" class="growth-row">
      <span class="growth-id">{{ lesson.id }}</span>
      <div class="growth-track">
        <div class="growth-bar" :style="{ width: `${Math.max((lesson.lines / maxLines) * 100, 2)}%` }" />
      </div>
      <span class="growth-lines">{{ lesson.lines }} 行</span>
    </div>
  </section>
</template>

<style scoped>
.stage { margin-top: 2.5rem; }
.note { font-size: 0.85em; font-weight: normal; opacity: 0.6; margin-left: 0.5rem; }
.cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.card { display: block; border: 1px solid var(--vp-c-border); border-radius: 8px; padding: 1rem; text-decoration: none; color: inherit; transition: border-color 0.2s; }
.card:hover { border-color: var(--vp-c-brand); }
.card-head { display: flex; align-items: baseline; gap: 0.5rem; }
.id { font-family: monospace; color: var(--vp-c-brand); font-weight: 600; }
.idea { opacity: 0.85; margin: 0.5rem 0; }
.badges { display: flex; gap: 0.5rem; }
.badge { font-size: 0.8em; border: 1px solid var(--vp-c-border); border-radius: 999px; padding: 0.1rem 0.6rem; opacity: 0.85; }
.dsh { margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.4rem; }
.chip { font-size: 0.75em; font-family: monospace; color: var(--vp-c-text-code); background: var(--vp-code-bg); border-radius: 4px; padding: 0.1rem 0.4rem; text-decoration: none; }
.bar { margin-top: 0.75rem; height: 4px; border-radius: 2px; background: var(--vp-c-brand); opacity: 0.5; }
.growth { margin-top: 3rem; }
.growth-row { display: flex; align-items: center; gap: 0.75rem; margin: 0.4rem 0; }
.growth-id { font-family: monospace; min-width: 3rem; color: var(--vp-c-brand); }
.growth-track { flex: 1; background: var(--vp-c-default-soft); border-radius: 4px; }
.growth-bar { height: 14px; border-radius: 4px; background: var(--vp-c-brand); opacity: 0.75; }
.growth-lines { font-size: 0.85em; opacity: 0.7; min-width: 4.5rem; text-align: right; }
</style>
```

- [ ] **Step 4: 写 timeline.md**

```markdown
# 学习时间线

从最小循环开始，每课解决一个问题；代码随课程长大，最后一课用真实的
`@deepseek-ai/dsh-*` 包组装你自己的 harness。

每课标注对应 deepseek-harness 的包（dsh 徽章）与验证过的版本。
当前已上线课程随写作推进更新；s02–s16 见[关于页](/about/)的写作计划。

<Timeline />
```

- [ ] **Step 5: 写首页 site/index.md**

```markdown
---
layout: home
hero:
  name: Learn DeepSeek Harness
  text: 从最小循环到生产级 agent harness
  tagline: 概念演进 + 可运行示例 + deepseek-harness 真实源码导读。不需要 API key，每课克隆即可跑。
  actions:
    - theme: brand
      text: 从 s01 开始
      link: /lessons/s01-min-loop/
    - theme: alt
      text: 看时间线
      link: /timeline/
    - theme: alt
      text: GitHub
      link: https://github.com/Lotus-7/learn-deepseek-harness
features:
  - icon: 🔁
    title: 阶段一 · 最小循环
    details: 循环、工具、会话日志——harness 的三块地基，纯手写零框架。
  - icon: 🛡
    title: 阶段二 · 可控与可恢复
    details: 权限审批、取消与错误恢复、上下文压缩。
  - icon: 🧩
    title: 阶段三 · 插件化
    details: ctx、可逆 effect、capability seam——dsh「一切皆插件」的机制。
  - icon: 🏭
    title: 阶段四 · 生产化能力
    details: 沙箱与统一执行世界、子代理、技能、持久化。
  - icon: 🚀
    title: 阶段五 · 组装与桥接
    details: profile/bundle 组装，用真实 dsh 包搭你自己的 harness。
---

## 快速开始

```sh
git clone https://github.com/Lotus-7/learn-deepseek-harness.git
cd learn-deepseek-harness
pnpm install
pnpm --filter @learn-dsh/s01-min-loop dev
```

无需 `DEEPSEEK_API_KEY`：所有课程默认使用剧本回放的 mock 模型。
```

- [ ] **Step 6: 写术语表 site/glossary.md**

```markdown
# 术语表

中文正文保留英文术语，本表对齐 [dsh 的 glossary](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.md)（验证版本 0.1.0-rc.5）。

| 术语 | 中文 | 一句话解释 |
|---|---|---|
| harness | 运行框架 | 包着模型的执行环境：循环、工具、权限、持久化 |
| agent loop / driver | 循环 / 驱动器 | 「调模型→跑工具→喂结果」的主循环；dsh 里叫 driver |
| turn | 轮 | 一次用户意图的完整生命周期，零或多个 step |
| step | 步 | 一次模型请求加上它调用的工具 |
| tool | 工具 | 模型可调用的能力单元：schema + execute |
| tool call | 工具调用 | 模型输出的结构化执行请求 |
| session event | 会话事件 | 追加进会话日志的 durable 事实 |
| session log | 会话日志 | append-only 的事件流，模型上下文的唯一来源 |
| append-only | 只追加 | 日志只增不改；重放即重建全部状态 |
| deriveMessages | 派生消息 | 从会话日志投影出模型可见的历史 |
| capability seam | 能力接缝 | 可替换能力的接口：Definition / Provider / Consumer 三角色 |
| Service Definition | 服务定义 | seam 的接口声明 |
| Service Provider | 服务提供者 | seam 的实现（如本地 FS、远程沙箱 FS） |
| Consumer | 消费者 | 使用 seam 的代码，常见为面向模型的工具 |
| plugin | 插件 | dsh 的一切：向共享 ctx 贡献服务、事件、可逆 effect |
| ctx | 上下文 | 插件挂载与协作的共享对象 |
| reversible effect | 可逆 effect | 注册即返回清理函数，插件卸载时自动回滚 |
| typed events | 类型化事件 | 声明合并扩展的事件表，带类型与文档 |
| waterfall | 瀑布 | 监听器必须调 next() 委托的拦截链 |
| profile | 配置组 | 命名的插件树组合，如 web / headless |
| bundle | 捆绑层 | 可安装的插件配置层，可被上层 patch |
| mock model | 剧本模型 | 回放预录响应的模型替身，教学与测试用 |
```

- [ ] **Step 7: 写关于页 site/about.md**

```markdown
# 关于

本站通过「概念演进 + 可运行最小示例 + 真实源码导读」三段式，
拆解 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
（dsh）——一个构建在 vendored Cordis 上、一切皆插件的生产级 agent harness。

与 [Learn Claude Code](https://learn.shareai.run/zh/timeline/) 的区别：
那边的教学对象源码不可读，只能从零重建；dsh 是开源生产代码库，本站
每课都直接导读真实包，示例是通往真码的桥。

## 怎么跑课程

```sh
pnpm install
pnpm --filter @learn-dsh/s01-min-loop dev   # 任意一课，无需 API key
pnpm test                                    # 全部课程的 smoke 测试
```

## 版本锚定

dsh 处于 pre-release，会自由重命名与重排包。每课 `lesson.yaml` 的
`verifiedDshVersion` 标注导读链接验证过的版本；当前为 `0.1.0-rc.5`。
跟随升级是显式动作：改锚点、重走导读、更新文稿。

## 课程怎么长出来

写作即学习：每课按「读 dsh 对应包 → 写最小示例 → 写文稿 → 构建验证」
推进。s01 是本站第一课；s02–s16 按首页五个阶段陆续上线。

## 本站仓库

[learn-deepseek-harness](https://github.com/Lotus-7/learn-deepseek-harness)。
课程文稿与代码同目录（`lessons/<课>/`），站点页面由 `pnpm run sync`
从文稿投影生成，不重复维护。
```

- [ ] **Step 8: 构建验证**

Run: `pnpm install && pnpm site:build`
Expected: vitepress build 成功；输出 `site/.vitepress/dist/`；无 dead link 报错（timeline 卡片链接来自已生成的 lessons 页面）。

- [ ] **Step 9: 本地预览抽查**

Run: `pnpm --filter @learn-dsh/site preview`（或 `pnpm site:dev`）
手动检查：首页 hero 与快速开始、`/timeline/` 出现 s01 卡片（行数/工具徽章、dsh 徽章、增长条）、`/lessons/s01-min-loop/` 渲染课程文稿、`/glossary/`、`/about/`。确认后 Ctrl+C 退出。

- [ ] **Step 10: Commit**

```bash
git add site/package.json site/.vitepress site/index.md site/timeline.md site/glossary.md site/about.md pnpm-lock.yaml
git commit -m "feat: VitePress 站点——首页、时间线、术语表、关于页"
```

---

### Task 7: CI 与 GitHub Pages 部署

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: Task 1 的 `pnpm test`、Task 5 的 `pnpm run sync`、Task 6 的 `pnpm site:build`。
- Produces: PR/push 上跑测试与构建的 CI；master 推送后自动发布 GitHub Pages。

- [ ] **Step 1: 写 .github/workflows/ci.yml**

```yaml
name: ci
on:
  push:
    branches: [master]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 11
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run sync
      - name: 元数据必须与代码同步（防止手抄统计值漂移）
        run: git diff --exit-code
      - run: pnpm test
      - run: pnpm run site:build
```

- [ ] **Step 2: 写 .github/workflows/deploy.yml**

```yaml
name: deploy
on:
  push:
    branches: [master]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: deploy
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 11
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run site:build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site/.vitepress/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 3: 创建 GitHub 仓库并推送**

Run: `gh repo create Lotus-7/learn-deepseek-harness --public --source . --push`
Expected: 远端创建成功，master 推送完成。（若小七大人想用别的名字，同步改 `site/.vitepress/config.ts`、`site/index.md`、`site/about.md` 里的 GitHub 链接再推送。）

- [ ] **Step 4: 手动开启 Pages（一次性）**

GitHub 仓库 → Settings → Pages → Source 选 **GitHub Actions**。deploy workflow 的下次触发即可用；本次推送已触发，若因 Pages 未配置而失败，配置后重跑：`gh run rerun <run-id> --failed`。

- [ ] **Step 5: 验证工作流**

Run: `gh run list --limit 3`
Expected: ci 与 deploy 均为 success；`gh api repos/Lotus-7/learn-deepseek-harness/pages --jq .html_url` 给出站点地址且可访问。

- [ ] **Step 6: Commit（若步骤 3 有链接调整）**

```bash
git add -A
git commit -m "ci: GitHub Actions 测试与 Pages 部署"
git push
```

---

### Task 8: 根 README 与端到端验收

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: 前面全部任务的产物。
- Produces: 仓库入口文档；MVP 验收完成的基线。

- [ ] **Step 1: 写 README.md**

```markdown
# Learn DeepSeek Harness

从最小循环到生产级 agent harness 的学习课程：概念演进 + 可运行示例 +
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 真实源码导读。

在线阅读：GitHub Pages（见 About）；课程时间线从 [s01 最小循环](lessons/s01-min-loop/README.md) 开始。

## 快速开始

需要 Node >= 22 与 pnpm。

```sh
pnpm install
pnpm --filter @learn-dsh/s01-min-loop dev   # 跑任意一课，无需 API key
pnpm test                                    # 全部课程的 smoke 测试
pnpm site:dev                                # 本地起站点
```

## 仓库结构

```
lessons/    每课一个自包含包：README.md（文稿）+ lesson.yaml（元数据）+ src/
  shared/   课程共享的 mock 模型适配器
scripts/    sync-lessons：统计元数据 + 投影站点页面
site/       VitePress 站点（lessons 页面由脚本生成，不入库）
```

## 写作约定

- 新增一课：`lessons/<sXX-slug>/` 按 s01 模式建包与文稿，然后 `pnpm run sync`，
  再在 `site/.vitepress/config.ts` 的 sidebar 加一行。
- 每课工具必须用 `defineTool` 定义（统计口径）；行数/工具数由脚本写回，
  CI 用 `git diff --exit-code` 防手抄漂移。
- dsh 源码链接在 lesson.yaml 的 `verifiedDshVersion` 锚定验证版本。
```

- [ ] **Step 2: 端到端验收**

依次运行并确认：

```sh
git checkout -- . && pnpm run sync && git diff --exit-code   # 元数据与代码一致
pnpm test                                                     # 全部 PASS
pnpm site:build                                               # 构建成功
pnpm --filter @learn-dsh/s01-min-loop dev                     # 输出 s01 对话 transcript
```

Expected: 四条全部成功。任何一条失败，回对应 Task 修复后重跑。

- [ ] **Step 3: Commit 并推送**

```bash
git add README.md
git commit -m "docs: 根 README——快速开始与写作约定"
git push
```

---

## 完成后的下一步（不在本计划内）

1. s02（tools 守卫管线）起按学习环逐课推进，每课可独立小计划；
2. 首课上线后把站点地址回填到 README 与 About；
3. 上游 dsh 发新版本时，显式升级 `verifiedDshVersion` 并重走导读。
