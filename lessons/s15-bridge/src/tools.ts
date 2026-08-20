/**
 * 用真实 dsh 的 `defineTool` 定义工具——与课程前 14 课自己的 defineTool
 * 同名同构，但这里连参数校验、输出 schema、模型面渲染都是真包在生产里
 * 用的那套。`execute` 返回「规范值」（canonical value），`output.render`
 * 把规范值投影成模型可见的 content 块——工具结果回喂走的就是它。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/** s01 的 add 工具在真包上的重写：整数相加，规范值是 number。 */
export const addTool = defineTool({
  name: 'add',
  description: '把两个整数相加并返回它们的和',
  parameters: {
    a: { type: 'integer', description: '左操作数' },
    b: { type: 'integer', description: '右操作数' },
  },
  output: {
    schema: { type: 'number', description: '两数之和' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  execute: async (args) => args.a + args.b,
})

/** s01 的 echo 工具：复读传入文本，规范值是 string。 */
export const echoTool = defineTool({
  name: 'echo',
  description: '原样复读传入的文本',
  parameters: {
    text: { type: 'string', description: '要复读的文本' },
  },
  output: {
    schema: { type: 'string', description: '复读的文本' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  execute: async (args) => args.text,
})

/** 本 harness 的工具名册：注册进 ToolRuntime 的全部工具。 */
export const TOOL_ROSTER = [addTool, echoTool]
