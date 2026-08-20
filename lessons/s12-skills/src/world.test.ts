import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createMockModel, toolCall, type ModelResponse } from '@learn-dsh/mock-model'
import { Ctx } from './cordis'
import { FsError } from './fs-service'
import { fsTools } from './fs-tools'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { permissionPlugin } from './plugin-permission'
import { loopPlugin } from './plugin-loop'
import type { SessionLog } from './log'
import { worldPlugin } from './world-plugin'
import { worldTools } from './world-tools'
import { createLocalWorld } from './world-local'
import { createSandboxWorld } from './world-sandbox'
import { WorldError, type ExecutionWorld } from './world-service'

/** 本地世界的测试根：真磁盘上的临时目录，全部用例跑完清理。 */
const localRoot = mkdtempSync(join(tmpdir(), 'learn-s10-test-'))
afterAll(() => {
  rmSync(localRoot, { recursive: true, force: true })
})

/** 两个世界共用的白名单（LocalWorld 用；SandboxWorld 无白名单机制）。 */
const LOCAL_ALLOW = ['echo', 'cat', 'wc', 'node'] as const

/**
 * 接口即契约的直接体现：同一份断言集对两个世界各跑一遍。
 * LocalWorld 用真 child_process——断言只用固定命令、固定输入（echo/cat/wc/node -e
 * 在 macOS 与 Linux 上行为一致；退出码与 stdout 的首个词是跨平台稳定面）。
 */
const WORLDS: { name: string; create: () => ExecutionWorld; base: string }[] = [
  { name: 'LocalWorld', create: () => createLocalWorld({ root: localRoot, allowedCommands: [...LOCAL_ALLOW] }), base: localRoot },
  { name: 'SandboxWorld', create: () => createSandboxWorld(), base: '/sandbox' },
]

for (const { name, create, base } of WORLDS) {
  describe(`接口即契约：${name} 过同一套断言`, () => {
    it('写文件 → 读回一致；父目录连同创建', async () => {
      const world = create()
      const notes = `${base}/notes.md`
      await world.writeFile(notes, '第一行\n第二行\n')
      await expect(world.readFile(notes)).resolves.toBe('第一行\n第二行\n')
    })

    it('listDir 列出刚写的文件（按名排序，不读内容）', async () => {
      const world = create()
      await world.writeFile(`${base}/dir/b.md`, 'x')
      await world.writeFile(`${base}/dir/a.md`, 'x')
      await expect(world.listDir(`${base}/dir`)).resolves.toEqual([
        { name: 'a.md', type: 'file' },
        { name: 'b.md', type: 'file' },
      ])
    })

    it('spawn echo：exit 0，stdout 是参数原文', async () => {
      const world = create()
      const done = await world.spawn('echo', ['hello', 'world'])
      expect(done.exitCode).toBe(0)
      expect(done.stdout.trim()).toBe('hello world')
      expect(done.stderr).toBe('')
    })

    it('同一段脚本：写文件 → wc -l 数出换行数 → cat 读回原文', async () => {
      const world = create()
      const notes = `${base}/mission/notes.md`
      await world.writeFile(notes, '一\n二\n三\n')
      const counted = await world.spawn('wc', ['-l', notes])
      expect(counted.exitCode).toBe(0)
      // 真 wc 输出「       3 /path」，虚拟 wc 输出「3 /path」——首个词都是行数。
      expect(counted.stdout.trim().split(/\s+/)[0]).toBe('3')
      const readBack = await world.spawn('cat', [notes])
      expect(readBack.exitCode).toBe(0)
      expect(readBack.stdout).toBe('一\n二\n三\n')
    })

    it('文件不存在是执行结果不是异常：cat 退出码 1 + stderr', async () => {
      const world = create()
      const done = await world.spawn('cat', [`${base}/missing.md`])
      expect(done.exitCode).not.toBe(0)
      expect(done.stderr).toContain('missing.md')
    })

    it('fs 面错误是带码的 FsError（s09 契约原样成立）', async () => {
      const world = create()
      const failure = await world.readFile(`${base}/missing.md`).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(FsError)
    })
  })
}

describe('LocalWorld 部署差异：白名单在 fork 之前', () => {
  it('白名单外命令 → WORLD_COMMAND_DENIED（不是 127：进程根本没启动）', async () => {
    const world = createLocalWorld({ root: localRoot, allowedCommands: ['echo'] })
    // 如果检查发生在 fork 之后，会先撞上 ENOENT → 127；得到的是策略拒绝码，
    // 证明白名单在 fork 之前执行。
    const failure = await world.spawn('bash', ['-c', 'echo hi']).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorldError)
    expect(failure).toMatchObject({ code: 'WORLD_COMMAND_DENIED' })
  })

  it('白名单经配置传入：不同实例放行不同命令', async () => {
    const narrow = createLocalWorld({ root: localRoot, allowedCommands: ['echo'] })
    const wide = createLocalWorld({ root: localRoot, allowedCommands: ['echo', 'wc'] })
    await expect(narrow.spawn('wc', ['-l', `${localRoot}/x`])).rejects.toMatchObject({ code: 'WORLD_COMMAND_DENIED' })
    // wc 在 wide 的白名单里：跑的是它自己（不存在的文件）→ 执行结果 1，不是拒绝。
    const done = await wide.spawn('wc', ['-l', `${localRoot}/not-there.md`])
    expect(done.exitCode).toBe(1)
  })

  it('白名单内但机器上没有 → 127（部署事实，不是策略拒绝）', async () => {
    const world = createLocalWorld({ root: localRoot, allowedCommands: ['definitely-not-in-path'] })
    const done = await world.spawn('definitely-not-in-path', [])
    expect(done).toMatchObject({ exitCode: 127, stdout: '' })
    expect(done.stderr).not.toBe('')
  })

  it('fs 面越界 → FS_OUT_OF_ROOT（与 Sandbox 的围栏对称）', async () => {
    const world = createLocalWorld({ root: localRoot, allowedCommands: ['echo'] })
    await expect(world.writeFile('/tmp/learn-s10-escape-attempt.md', 'x')).rejects.toMatchObject({ code: 'FS_OUT_OF_ROOT' })
  })

  it('非零退出码照常 resolve：命令跑了但失败是输出事实', async () => {
    const world = createLocalWorld({ root: localRoot, allowedCommands: ['node'] })
    const done = await world.spawn('node', ['-e', 'process.stderr.write("boom"); process.exit(3)'])
    expect(done).toMatchObject({ exitCode: 3, stderr: 'boom' })
  })
})

describe('SandboxWorld 部署差异：路径围栏在解释命令之前', () => {
  it('碰 FS 的命令拿越界路径 → WORLD_PATH_DENIED，虚拟 FS 零副作用', async () => {
    const world = createSandboxWorld()
    const failure = await world.spawn('cat', ['/etc/hosts']).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorldError)
    expect(failure).toMatchObject({ code: 'WORLD_PATH_DENIED' })
    await expect(world.spawn('wc', ['-l', '/etc/hosts'])).rejects.toMatchObject({ code: 'WORLD_PATH_DENIED' })
    // 拒绝发生在解释命令之前：围栏内什么都没多出来。
    await expect(world.listDir('/sandbox')).resolves.toEqual([])
  })

  it('echo 的「路径样」参数只是文本，不适用围栏', async () => {
    const world = createSandboxWorld()
    const done = await world.spawn('echo', ['/etc/passwd'])
    expect(done.exitCode).toBe(0)
    expect(done.stdout.trim()).toBe('/etc/passwd')
  })

  it('fs 面越界写入 → FS_OUT_OF_ROOT，且没有半个文件落地', async () => {
    const world = createSandboxWorld()
    await expect(world.writeFile('/etc/hosts', 'x')).rejects.toMatchObject({ code: 'FS_OUT_OF_ROOT' })
    await expect(world.listDir('/sandbox')).resolves.toEqual([])
  })

  it('未知虚拟命令 → 127：与真机器的「命令不存在」同语义', async () => {
    const world = createSandboxWorld()
    const done = await world.spawn('curl', ['https://example.com'])
    expect(done).toMatchObject({ exitCode: 127, stdout: '' })
    expect(done.stderr).toContain('curl')
  })

  it('虚拟命令的用法错误是执行结果：wc 不带 -l → 退出码 2', async () => {
    const world = createSandboxWorld()
    const done = await world.spawn('wc', ['-c', '/sandbox/x'])
    expect(done.exitCode).toBe(2)
    expect(done.stderr).toContain('-l')
  })
})

/** 装配一个最小世界：模型 + 工具会话 + 选定的 world provider + loop。 */
function assemble(script: readonly ModelResponse[], world: ExecutionWorld): Ctx {
  const ctx = new Ctx()
  ctx.mount(modelPlugin(createMockModel([...script])))
  ctx.mount(toolsSessionPlugin([...fsTools(ctx), ...worldTools(ctx)]))
  ctx.mount(permissionPlugin({ rules: { '*': 'allow' } }))
  ctx.mount(worldPlugin(world))
  ctx.mount(loopPlugin())
  return ctx
}

/** 第一幕剧本（按世界基目录生成）：写文件 → wc 统计 → cat 读回 → 回答。 */
function missionScript(base: string): ModelResponse[] {
  const notes = `${base}/notes.md`
  return [
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('t1', 'write_file', { path: notes, content: '一\n二\n三\n' })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('t2', 'run_command', { command: 'wc', args: ['-l', notes] })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [toolCall('t3', 'run_command', { command: 'cat', args: [notes] })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: '已核对：3 行，读回一致。' }, finishReason: 'stop' },
  ]
}

describe('Consumer 零感知世界（换 provider 不改调用方）', () => {
  it('world-tools 源码钉住 import 关系：不 import 任何世界实现', () => {
    const source = readFileSync(new URL('./world-tools.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from '\.\/world-(local|sandbox)'/)
    expect(source).not.toMatch(/createLocalWorld|createSandboxWorld/)
    expect(source).toContain(`from './world-service'`)
  })

  it('world-tools 源码不含 child_process：bash 型工具活在接口上，不活在进程上', () => {
    const source = readFileSync(new URL('./world-tools.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('child_process')
  })

  it('world-sandbox 源码不含 child_process：零真进程是源码事实', () => {
    const source = readFileSync(new URL('./world-sandbox.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('child_process')
  })

  it('同一任务两个世界：事件类型序列同形、最终回答逐字相同', async () => {
    const run = async (world: ExecutionWorld, base: string): Promise<SessionLog> => {
      const ctx = assemble(missionScript(base), world)
      await ctx.get('agent').run('记笔记、统计行数并读回')
      return ctx.get('sessions').log
    }
    const localLog = await run(createLocalWorld({ root: localRoot, allowedCommands: [...LOCAL_ALLOW] }), localRoot)
    const sandboxLog = await run(createSandboxWorld(), '/sandbox')
    expect(sandboxLog.events.map((event) => event.type)).toEqual(localLog.events.map((event) => event.type))
    expect(sandboxLog.deriveMessages().at(-1)).toEqual(localLog.deriveMessages().at(-1))
  })
})

describe('策略拒绝回喂：模型读补救语换安全路线', () => {
  it('白名单拒绝：第一份 tool/result 带码与补救语，第二份成功收尾', async () => {
    const script: ModelResponse[] = [
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('b1', 'run_command', { command: 'bash', args: ['-c', 'wc -l < x'] })] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('b2', 'run_command', { command: 'echo', args: ['改用白名单内命令'] })] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: 'bash 被拒，我改用白名单内的 echo。' }, finishReason: 'stop' },
    ]
    const ctx = assemble(script, createLocalWorld({ root: localRoot, allowedCommands: ['echo'] }))
    await ctx.get('agent').run('统计文件行数')
    const results = ctx.get('sessions').log.events.filter((event) => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    if (results[0]?.type !== 'tool/result' || results[1]?.type !== 'tool/result') throw new Error('unreachable：上面已断言两条')
    expect(results[0].output).toContain('WORLD_COMMAND_DENIED')
    expect(results[0].output).toContain('白名单内的命令')
    expect(results[1].output).toContain('exit 0')
    expect(ctx.get('sessions').log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' })
  })

  it('围栏拒绝：越界 cat 回喂补救语，换围栏内路径成功', async () => {
    const script: ModelResponse[] = [
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('g1', 'run_command', { command: 'cat', args: ['/etc/hosts'] })] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('g2', 'write_file', { path: '/sandbox/hosts.md', content: '127.0.0.1 localhost' })] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('g3', 'run_command', { command: 'cat', args: ['/sandbox/hosts.md'] })] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: '越界被围栏拦下，改用围栏内路径后读回成功。' }, finishReason: 'stop' },
    ]
    const ctx = assemble(script, createSandboxWorld())
    await ctx.get('agent').run('读一下 hosts')
    const results = ctx.get('sessions').log.events.filter((event) => event.type === 'tool/result')
    expect(results).toHaveLength(3)
    if (results[0]?.type !== 'tool/result' || results[2]?.type !== 'tool/result') throw new Error('unreachable：上面已断言三条')
    expect(results[0].output).toContain('WORLD_PATH_DENIED')
    expect(results[0].output).toContain('围栏内的路径')
    expect(results[2].output).toContain('127.0.0.1 localhost')
    expect(ctx.get('sessions').log.events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' })
  })

  it('非零退出码不是错误：照常回喂 exit/stdout/stderr，不带策略码', async () => {
    const script: ModelResponse[] = [
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('e1', 'run_command', { command: 'cat', args: ['/sandbox/absent.md'] })] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: '文件还不存在（cat 退出码 1），我先写入再读。' }, finishReason: 'stop' },
    ]
    const ctx = assemble(script, createSandboxWorld())
    await ctx.get('agent').run('读文件')
    const results = ctx.get('sessions').log.events.filter((event) => event.type === 'tool/result')
    if (results[0]?.type !== 'tool/result') throw new Error('unreachable：cat 必有一条结果')
    expect(results[0].output).toContain('exit 1')
    expect(results[0].output).toContain('stderr:')
    expect(results[0].output).not.toContain('WORLD_')
  })
})

describe('装配显式性：一个对象两个键，成对挂载', () => {
  it('重复挂载第二个世界：第一个键（fs）重名当场抛错', () => {
    const ctx = assemble([], createSandboxWorld())
    expect(() => ctx.mount(worldPlugin(createLocalWorld({ root: localRoot, allowedCommands: ['echo'] })))).toThrow('服务 "fs" 已贡献')
  })

  it('卸载世界：fs 与 world 两个服务键同时消失，能力响亮回喂', async () => {
    const script: ModelResponse[] = [
      { message: { role: 'assistant', content: null, tool_calls: [toolCall('u1', 'run_command', { command: 'echo', args: ['hi'] })] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: '世界不在场，跑不了命令。' }, finishReason: 'stop' },
    ]
    // 这里需要 worldPlugin 的卸载句柄，直接内联装配（assemble 不返回卸载函数）。
    const ctx = new Ctx()
    ctx.mount(modelPlugin(createMockModel([...script])))
    ctx.mount(toolsSessionPlugin([...fsTools(ctx), ...worldTools(ctx)]))
    ctx.mount(permissionPlugin({ rules: { '*': 'allow' } }))
    const detach = ctx.mount(worldPlugin(createSandboxWorld()))
    ctx.mount(loopPlugin())
    detach()
    expect(() => ctx.get('world')).toThrow('没有叫 "world" 的服务')
    expect(() => ctx.get('fs')).toThrow('没有叫 "fs" 的服务')
    await ctx.get('agent').run('跑个命令')
    const results = ctx.get('sessions').log.events.filter((event) => event.type === 'tool/result')
    if (results[0]?.type !== 'tool/result') throw new Error('unreachable：run_command 必有一条结果')
    expect(results[0].output).toContain('没有叫 "world" 的服务')
  })
})
