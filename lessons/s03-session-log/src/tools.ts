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

/**
 * 演示守卫否决路径的工具：本身不碰磁盘，但它的调用会被
 * 「必须显式 force: true」的 preExecute 守卫拦下（守卫挂在执行管线上，见 src/index.ts）。
 */
export const deleteFileTool = defineTool({
  name: 'delete_file',
  description: '删除一个文件（课程演示，不真的碰磁盘）',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要删除的文件路径' },
      force: { type: 'boolean', description: '删除确认开关，必须显式传 true' },
    },
    required: ['path'],
  },
  execute: async (args) => `已删除 ${String(args.path)}`,
})
