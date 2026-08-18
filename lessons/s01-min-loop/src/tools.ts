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
