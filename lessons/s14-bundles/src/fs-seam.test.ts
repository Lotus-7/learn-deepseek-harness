import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx } from './cordis'
import { createMemoryFs } from './fs-memory'
import { createRemoteFs } from './fs-remote'
import { FsError, type FsService } from './fs-service'
import { fsPlugin } from './plugin-fs'
import { fsTools } from './fs-tools'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { loopPlugin } from './plugin-loop'
import type { SessionLog } from './log'

/**
 * 接口即契约的直接体现：同一份断言集对两个 provider 各跑一遍。
 * 远端 provider 注入零等待（契约断言不关心时钟——延迟行为单独测）。
 */
const PROVIDERS: { name: string; create: () => FsService; base: string }[] = [
  { name: 'MemoryFs', create: () => createMemoryFs(), base: '/t' },
  { name: 'RemoteFs', create: () => createRemoteFs({ wait: () => Promise.resolve() }), base: '/remote/t' },
]

for (const { name, create, base } of PROVIDERS) {
  describe(`接口即契约：${name} 过同一套断言`, () => {
    it('建文件 → 列目录 → 读回（roundtrip，目录项按名排序）', async () => {
      const fs = create()
      await fs.writeFile(`${base}/notes.md`, '内容 A')
      await expect(fs.listDir(base)).resolves.toEqual([{ name: 'notes.md', type: 'file' }])
      await expect(fs.readFile(`${base}/notes.md`)).resolves.toBe('内容 A')
    })

    it('writeFile 连建父目录：深层文件让中间目录作为子项列出', async () => {
      const fs = create()
      await fs.writeFile(`${base}/sub/deep/x.md`, '深')
      await expect(fs.listDir(base)).resolves.toEqual([{ name: 'sub', type: 'directory' }])
      await expect(fs.listDir(`${base}/sub`)).resolves.toEqual([{ name: 'deep', type: 'directory' }])
    })

    it('writeFile 整体替换：同一路径再写即覆盖', async () => {
      const fs = create()
      await fs.writeFile(`${base}/a.md`, '旧')
      await fs.writeFile(`${base}/a.md`, '新')
      await expect(fs.readFile(`${base}/a.md`)).resolves.toBe('新')
    })

    it('readFile 不存在 → FS_NOT_FOUND', async () => {
      const fs = create()
      await expect(fs.readFile(`${base}/missing.md`)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    })

    it('readFile 目录 → FS_NOT_A_FILE', async () => {
      const fs = create()
      await fs.writeFile(`${base}/sub/a.md`, 'x')
      await expect(fs.readFile(`${base}/sub`)).rejects.toMatchObject({ code: 'FS_NOT_A_FILE' })
    })

    it('writeFile 目标当前是目录 → FS_NOT_A_FILE', async () => {
      const fs = create()
      await fs.writeFile(`${base}/sub/a.md`, 'x')
      await expect(fs.writeFile(`${base}/sub`, 'x')).rejects.toMatchObject({ code: 'FS_NOT_A_FILE' })
    })

    it('listDir 文件 → FS_NOT_A_DIRECTORY；不存在 → FS_NOT_FOUND', async () => {
      const fs = create()
      await fs.writeFile(`${base}/a.md`, 'x')
      await expect(fs.listDir(`${base}/a.md`)).rejects.toMatchObject({ code: 'FS_NOT_A_DIRECTORY' })
      await expect(fs.listDir(`${base}/missing`)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    })

    it('错误是带码的 FsError（程序按码分支，不解析文本）', async () => {
      const fs = create()
      const failure = await fs.readFile(`${base}/missing.md`).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(FsError)
    })
  })
}

describe('部署差异：RemoteFs 的围栏与往返', () => {
  it('越界路径 → FS_OUT_OF_ROOT（与不存在区分开），且不产生副作用', async () => {
    const fs = createRemoteFs({ wait: () => Promise.resolve() })
    for (const op of [
      () => fs.readFile('/workspace/x.md'),
      () => fs.writeFile('/workspace/x.md', 'x'),
      () => fs.listDir('/workspace'),
    ]) {
      await expect(op()).rejects.toMatchObject({ code: 'FS_OUT_OF_ROOT' })
    }
    // 越界写入没有留下半个世界：根内照旧为空（fence 在动手前拒绝）
    await expect(fs.listDir('/remote')).resolves.toEqual([])
  })

  it('围栏在往返之前：越界调用零等待（fail fast），到站操作各等一次', async () => {
    let roundTrips = 0
    const fs = createRemoteFs({ latencyMs: 40, wait: () => { roundTrips += 1; return Promise.resolve() } })
    await expect(fs.writeFile('/outside/x.md', 'x')).rejects.toMatchObject({ code: 'FS_OUT_OF_ROOT' })
    expect(roundTrips).toBe(0)
    await fs.writeFile('/remote/x.md', 'x')
    expect(roundTrips).toBe(1)
    await fs.readFile('/remote/x.md')
    expect(roundTrips).toBe(2)
  })

  it('根内一切照契约行事：MemoryFs 的断言集在根内同样成立', async () => {
    const fs = createRemoteFs({ wait: () => Promise.resolve() })
    await fs.writeFile('/remote/t/a.md', 'A')
    await expect(fs.readFile('/remote/t/a.md')).resolves.toBe('A')
    await expect(fs.listDir('/remote/t')).resolves.toEqual([{ name: 'a.md', type: 'file' }])
  })
})

/** 装配一个最小世界：模型 + 工具会话 +（可选）provider + loop。测试不挂权限/压缩。 */
function assemble(script: readonly ModelResponse[], fs?: FsService): { ctx: Ctx; unmountFs?: () => void } {
  const ctx = new Ctx()
  ctx.mount(modelPlugin(createMockModel([...script])))
  ctx.mount(toolsSessionPlugin(fsTools(ctx)))
  let unmountFs: (() => void) | undefined
  if (fs !== undefined) unmountFs = ctx.mount(fsPlugin(fs))
  ctx.mount(loopPlugin())
  return { ctx, unmountFs }
}

/** 第一幕剧本：建文件 → 列目录 → 读回 → 引用写入内容的回答（按世界基目录生成）。 */
function missionScript(base: string): ModelResponse[] {
  return [
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'write_file', { path: `${base}/notes.md`, content: '集群巡检结论：共 47 台节点。' })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'list_dir', { path: base })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('t3', 'read_file', { path: `${base}/notes.md` })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: '已确认：集群共 47 台节点。' }, finishReason: 'stop' },
  ]
}

describe('Consumer 零感知 provider（换实现不改调用方）', () => {
  it('fs-tools 源码钉住 import 关系：不 import 任何 provider、不直接构造实现', () => {
    const source = readFileSync(new URL('./fs-tools.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from '\.\/fs-(memory|remote)'/)
    expect(source).not.toMatch(/createMemoryFs|createRemoteFs/)
    expect(source).toContain(`from './fs-service'`)
    expect(source).toContain(`from './tools'`)
  })

  it('同一任务两个世界：事件类型序列同形、最终回答逐字相同', async () => {
    const run = async (fs: FsService, base: string): Promise<SessionLog> => {
      const { ctx } = assemble(missionScript(base), fs)
      await ctx.get('agent').run('记笔记并读回确认')
      return ctx.get('sessions').log
    }
    const memoryLog = await run(createMemoryFs(), '/workspace')
    const remoteLog = await run(createRemoteFs({ wait: () => Promise.resolve() }), '/remote/workspace')
    expect(remoteLog.events.map((event) => event.type)).toEqual(memoryLog.events.map((event) => event.type))
    expect(remoteLog.deriveMessages().at(-1)).toEqual(memoryLog.deriveMessages().at(-1))
  })
})

describe('越界错误回喂：模型读补救语换安全路径', () => {
  const script: ModelResponse[] = [
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('b1', 'write_file', { path: '/workspace/attempt.md', content: '第一次尝试' })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('b2', 'write_file', { path: '/remote/workspace/attempt.md', content: '改用根内路径' })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: '第一次尝试越界被拒，我换到了根内路径。' }, finishReason: 'stop' },
  ]

  it('第一份 tool/result 带码与补救语，第二份成功，turn 正常收尾', async () => {
    const { ctx } = assemble(script, createRemoteFs({ wait: () => Promise.resolve() }))
    await ctx.get('agent').run('写到 /workspace/attempt.md')
    const results = ctx.get('sessions').log.events.filter((event) => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    if (results[0]?.type !== 'tool/result' || results[1]?.type !== 'tool/result') throw new Error('unreachable：上面已断言两条')
    expect(results[0].output).toContain('FS_OUT_OF_ROOT')
    expect(results[0].output).toContain('根之内')
    expect(results[1].output).toContain('已写入 /remote/workspace/attempt.md')
    expect(ctx.get('sessions').log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' })
  })
})

describe('装配显式性：选谁与缺谁都在装配层响亮', () => {
  const readScript: ModelResponse[] = [
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('r1', 'read_file', { path: '/remote/notes.md' })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: '读不了，能力不在场。' }, finishReason: 'stop' },
  ]

  it('重复挂载第二个 provider：服务重名当场抛错（不静默顶掉）', () => {
    const { ctx } = assemble([], createMemoryFs())
    expect(() => ctx.mount(fsPlugin(createRemoteFs()))).toThrow('服务 "fs" 已贡献')
  })

  it('不装 provider：工具执行把「服务缺失」作为错误回喂，循环活着收尾', async () => {
    const { ctx } = assemble(readScript)
    await ctx.get('agent').run('读一下文件')
    const results = ctx.get('sessions').log.events.filter((event) => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    if (results[0]?.type !== 'tool/result') throw new Error('unreachable：上面已断言一条')
    expect(results[0].output).toContain('没有叫 "fs" 的服务')
    expect(ctx.get('sessions').log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' })
  })

  it('运行前卸载 provider：能力随 provider 消失，同一错误响亮回喂', async () => {
    const { ctx, unmountFs } = assemble(readScript, createRemoteFs())
    unmountFs?.()
    await ctx.get('agent').run('读一下文件')
    const results = ctx.get('sessions').log.events.filter((event) => event.type === 'tool/result')
    if (results[0]?.type !== 'tool/result') throw new Error('unreachable：read_file 必有一条结果')
    expect(results[0].output).toContain('没有叫 "fs" 的服务')
  })
})
