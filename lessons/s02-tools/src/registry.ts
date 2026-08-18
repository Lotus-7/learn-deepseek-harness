import type { ToolSchema } from '@learn-dsh/mock-model'
import type { Tool } from './tools'

/**
 * 工具注册表：名字 → 工具的名册。循环只跟它打交道——
 * 组装模型请求用 schemas()，执行用 lookup()。
 * dsh 对应 ToolRuntime（packages/core/tools）：那里是「全局层 + 每 agent scope 层」
 * 的 scoped 注册表，scoped 注册可 shadow 全局同名工具；本课是一张平表。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  /**
   * 注册一个工具。重名是装配错误，当场抛出而不是静默覆盖——
   * 两个同名工具都注册成功，比启动失败危险得多。
   * @param tool - defineTool 的产物。
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(
        `工具 "${tool.name}" 已注册（当前名册：${[...this.tools.keys()].join(', ')}）；重名通常是重复装配，请检查注册处`,
      )
    }
    this.tools.set(tool.name, tool)
  }

  /**
   * 按名查找工具。未知名拿到响亮错误（列出当前名册）而不是 undefined——
   * 让「名字对不上」在读代码时就能被发现。
   * @param name - 模型 tool_call 里的工具名。
   * @returns 名册里的那个工具。
   */
  lookup(name: string): Tool {
    const tool = this.tools.get(name)
    if (tool === undefined) {
      throw new Error(`没有叫 "${name}" 的工具（当前名册：${[...this.tools.keys()].join(', ')}）`)
    }
    return tool
  }

  /**
   * 组装模型请求用的 schema 列表。只投影模型可见字段（name/description/parameters），
   * execute 函数永远不出现在发给模型的内容里。
   * @returns 每个已注册工具一份 schema。
   */
  schemas(): ToolSchema[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }))
  }
}

/** 测试与演示的便捷构造：registryOf(addTool, echoTool) 一行建好名册。 */
export function registryOf(...tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of tools) registry.register(tool)
  return registry
}
