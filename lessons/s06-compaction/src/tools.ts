/**
 * 一个工具：schema 给模型看，execute 给循环调。
 * s05 起 execute 收到本次 turn 的取消 signal——签名是可选参数，s04 及更早的
 * 工具（只声明 args）零修改照常工作；要被打断的长任务必须监听它（见 slowScanTool）。
 * dsh 对应 packages/core/tools/src/index.ts 的 execute(args, exec)：取消 signal
 * 就在 exec 里，且工具可以声明协作式 timeoutMs 预算。
 */
export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>
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

/** 只读工具：无副作用，权限策略把它配成 allow 直通。 */
export const readFileTool = defineTool({
  name: 'read_file',
  description: '读取一个文件的内容（只读，无副作用）',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '要读取的文件路径' } },
    required: ['path'],
  },
  execute: async (args) => `「${String(args.path)}」的内容：项目周会纪要……（共 12 行）`,
})

/** 危险操作的安全替代：可恢复，权限策略允许模型在被拒后改道到这里。 */
export const moveToTrashTool = defineTool({
  name: 'move_to_trash',
  description: '把一个文件移入回收站（可恢复的清理方式）',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '要移入回收站的文件路径' } },
    required: ['path'],
  },
  execute: async (args) => `已把 ${String(args.path)} 移入回收站（可随时恢复）`,
})

/**
 * 会挂起的工具：正常完成要 60 秒（演示等不到），出口有两条——进场先查
 * signal（已取消就不再开工），挂起中监听 abort、在触发时清掉定时器并以
 * 取消原因落定——「AbortSignal 友好」的工具体写法。
 * 不监听 signal 的工具体没有中断点：JavaScript 砍不断正在跑的同进程代码
 * （dsh 的立场见 packages/core/tools/src/index.ts："the registry … cannot
 * hard-kill same-process code"），取消必须是协作的。
 */
export const slowScanTool = defineTool({
  name: 'slow_scan',
  description: '对给定范围做全盘扫描（演示用：任务很长，支持被外部取消）',
  parameters: {
    type: 'object',
    properties: { scope: { type: 'string', description: '要扫描的范围' } },
    required: ['scope'],
  },
  execute: (args, signal) => {
    // 进场检查：abort 可能落在管线入口检查之后的缝隙里（比如 preExecute 守卫
    // 等人审批的间隙）——已取消就不再开工，也不会白挂 60 秒（已 abort 的 signal
    // 不会再向迟到的监听器发事件）。AbortSignal 友好的第一课：先看 signal。
    signal?.throwIfAborted()
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve(`扫描完成：${String(args.scope)}（共 0 个问题）`), 60_000)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer) // 友好收尾：不留悬挂的定时器
          reject(signal.reason instanceof Error ? signal.reason : new Error('扫描被取消'))
        },
        { once: true },
      )
    })
  },
})

/** 抛错的工具：execute 抛出的错误经管线变成回喂模型的文本，循环不崩（可恢复）。 */
export const fetchStatsTool = defineTool({
  name: 'fetch_stats',
  description: '拉取实时构建统计（演示用：上游服务不稳定）',
  parameters: {
    type: 'object',
    properties: { source: { type: 'string', description: '数据源名称' } },
    required: ['source'],
  },
  execute: async () => {
    throw new Error('上游统计服务返回 500，暂时不可用')
  },
})

/** 抛错工具的安全替代：同一份事实的缓存副本，模型看到错误后改道到这里。 */
export const cachedStatsTool = defineTool({
  name: 'cached_stats',
  description: '读取缓存的构建统计（可能略旧，但稳定可用）',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async () => '缓存统计：本周构建 12 次，成功率 91.7%，平均耗时 3 分 40 秒',
})

/**
 * 输出冗长的日志检索工具（s06 的「燃料」）：每次返回 24 行命中的日志行，
 * 用来把多轮工具往返的派生历史推过压缩阈值。输出是确定性的——
 * 同样的 query 得到同样的日志行，压缩演示因此可复现。
 */
export const searchLogsTool = defineTool({
  name: 'search_logs',
  description: '在部署日志中检索关键词，返回命中的日志行（输出较长）',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '要检索的关键词' } },
    required: ['query'],
  },
  execute: async (args) => {
    const query = String(args.query)
    const lines = Array.from(
      { length: 24 },
      (_, index) =>
        `2026-08-18 0${(index % 9) + 1}:${String((index * 7) % 60).padStart(2, '0')}:${String((index * 13) % 60).padStart(2, '0')} [svc-${String((index % 6) + 1).padStart(2, '0')}] ${query} 命中：request_id=req-${1000 + index} latency_ms=${120 + index * 17} status=${index % 5 === 0 ? 'warn' : 'ok'}`,
    )
    return `检索 "${query}" 命中 24 行：\n${lines.join('\n')}`
  },
})
