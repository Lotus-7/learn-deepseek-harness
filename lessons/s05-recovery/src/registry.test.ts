import { describe, expect, it } from 'vitest'
import { registryOf, ToolRegistry } from './registry'
import { addTool, echoTool } from './tools'

describe('ToolRegistry', () => {
  it('重名注册当场抛错，而不是静默覆盖', () => {
    const registry = new ToolRegistry()
    registry.register(addTool)
    expect(() => registry.register(addTool)).toThrow(/"add" 已注册/)
  })

  it('lookup 未知名拿到响亮错误并列出当前名册', () => {
    const registry = registryOf(addTool, echoTool)
    expect(() => registry.lookup('multiply')).toThrow(/没有叫 "multiply" 的工具（当前名册：add, echo）/)
  })

  it('schemas() 只投影模型可见字段，execute 不进模型请求', () => {
    const registry = registryOf(addTool)
    expect(registry.schemas()).toEqual([
      {
        name: 'add',
        description: '计算两个整数的和',
        parameters: {
          type: 'object',
          properties: { a: { type: 'integer' }, b: { type: 'integer' } },
          required: ['a', 'b'],
        },
      },
    ])
  })
})
