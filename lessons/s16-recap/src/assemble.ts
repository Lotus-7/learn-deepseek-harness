import type { Model } from '@learn-dsh/mock-model'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Ctx, type Plugin } from './cordis'
import { deterministicSummarize } from './compaction'
import { modelPlugin } from './plugin-model'
import { toolsSessionPlugin } from './plugin-tools-session'
import { permissionPlugin } from './plugin-permission'
import { compactionPlugin } from './plugin-compaction'
import { loopPlugin } from './plugin-loop'
import { worldPlugin } from './world-plugin'
import { subagentPlugin } from './subagent-plugin'
import { createInProcessSubagentProvider } from './subagent-provider'
import { skillPlugin } from './skill-plugin'
import { workflowPlugin } from './workflow-plugin'
import { SKILLS, TOOL_CATALOG, summaryReportWorkflow, type Entry, type ResolvedBundle } from './bundles'
import { persistencePlugin } from './plugin-durable'
import type { LoggedEvent } from './log'
import { SESSION_FORMAT_VERSION, SessionFile, resumeSession } from './persistence'
import type { AskUser } from './permission'
import type { ExecutionWorld } from './world-service'

/**
 * 装配器：resolve 之后的第二半。分工与 dsh 一致——
 * **resolve 是纯函数**（层叠与校验，composeEntries「so composition, flag
 * derivation, and config dumps cannot drift from what boots」——组合结果可以
 * 离线计算、离线打印 `--dump-config`，不碰任何插件），**assemble 是效果**
 * （构造插件实例、按序挂载）。校验全部前置在 resolve：assemble 拿到的
 * {@link ResolvedBundle} 是「已校验」的类型级证据，这里不再重复查——
 * 名册里的名字必在目录、规则必点名名册内工具（同进程类型边界，静态契约
 * 已由 resolve 建立）。
 *
 * 运行时资源（{@link AssembleRuntime}）与 bundle 数据分离：模型适配器、
 * 执行世界、审批通道是**部署环境**注入的实例，profile 是**产品决策**数据
 * ——dsh 同款边界：cordis.yml 的行声明组合，`!!js` 表达式与 env 在挂载时
 * 求值，模型适配器的 key 从 settings/credentials 来（「Which adapters exist
 * is composition; which providers run is the user's settings document」，
 * bundle/base 的 cordis.patch.yml 注释）。
 */

/** 装配的运行时资源：bundle 数据之外，由启动环境注入的实例。 */
export interface AssembleRuntime {
  /** 模型适配器（mock 剧本或真实现；model 行挂它）。 */
  readonly model: Model
  /**
   * 会话文件目录（persistence 行挂它；s16 起 BASE 声明落盘，部署必须给目录
   * ——dsh 同位：$DSH_HOME 下的 sessions 目录）。目录里已存在 session.jsonl
   * 即 resume（种子历史经 `persistence` 服务流向 tools 行），否则物化新会话。
   */
  readonly sessionsDir: string
  /** 执行世界（world 行挂它；本机还是沙箱由部署决定，工具无感知）。 */
  readonly world: ExecutionWorld
  /**
   * ask 审批通道：permission 行的规则裁到 ask 时向它要答案。
   * 缺省时 s04 的 fail-safe 生效（无通道按 deny 处理）——「规则要问人」
   * 与「有没有人可问」是两件事：前者是产品数据，后者是部署资源。
   */
  readonly askUser?: AskUser
}

/**
 * 构造一行对应的插件实例。
 * @param entry - 已 resolve 的行（封闭判别联合，default 分支是编译期穷尽哨兵）。
 * @param runtime - 运行时资源。
 * @param ctx - 目标容器（需要 ctx 的 Consumer 工具经目录工厂构造）。
 * @returns 可挂载的插件。
 */
function buildEntry(entry: Entry, runtime: AssembleRuntime, ctx: Ctx): Plugin {
  switch (entry.plugin) {
    case 'model':
      return modelPlugin(runtime.model)
    case 'persistence': {
      // 部署资源就成一个决定：目录里有没有 session.jsonl——有即 resume
      // （扫描 + 修盘 + 种子事件），没有即物化新会话。resume 的种子经
      // persistence 服务出场（persistencePlugin 里），本 case 只决定「文件
      // 从哪来」；dsh 同位：SessionStore.prepare(id, { seed })。
      const path = join(runtime.sessionsDir, 'session.jsonl')
      if (!existsSync(path)) {
        const file = SessionFile.materialize(path, { version: SESSION_FORMAT_VERSION, id: 'session', createdAt: Date.now() }, [])
        return persistencePlugin(file, [])
      }
      const resumed = resumeSession(path)
      return persistencePlugin(SessionFile.openAppend(path), resumed.events)
    }
    case 'tools': {
      // 名册名字必在目录：resolve 已校验（ResolvedBundle 的不变式）。
      const tools = entry.tools.map((name) => TOOL_CATALOG[name]!(ctx))
      // persistence 行在 tools 行之前挂载（BASE 行序），resume 的种子已进场；
      // 没有 persistence 行的底座（测试自构）则是全新会话。探测不是兜底：
      // 两个手臂都是明确行为（续会话 / 新会话），见 Ctx.has 的注释。
      const seed: readonly LoggedEvent[] | undefined = ctx.has('persistence')
        ? ctx.get('persistence').seed
        : undefined
      return toolsSessionPlugin(tools, seed === undefined ? {} : { seed })
    }
    case 'permission':
      return permissionPlugin({
        rules: { ...entry.rules },
        defaultDecision: entry.defaultDecision,
        remember: entry.remember,
        askUser: runtime.askUser,
      })
    case 'compaction':
      return compactionPlugin({
        threshold: entry.threshold,
        keepTail: entry.keepTail,
        summarize: deterministicSummarize,
      })
    case 'world':
      return worldPlugin(runtime.world)
    case 'subagent':
      return subagentPlugin(createInProcessSubagentProvider(ctx))
    case 'skill':
      return skillPlugin([...SKILLS])
    case 'workflow':
      return workflowPlugin([summaryReportWorkflow(ctx)])
    case 'loop':
      return loopPlugin(entry.maxSteps === undefined ? {} : { maxSteps: entry.maxSteps })
    default:
      // 穷尽哨兵：Entry 加新 plugin 而本 switch 没跟上时，这行在编译期红。
      return assertNeverPlugin(entry)
  }
}

/** default 分支的编译期穷尽检查：走到这里的 entry 类型应是 never。 */
function assertNeverPlugin(entry: never): never {
  throw new Error(`装配行引用了未知插件（Entry 判别联合未穷尽）：${JSON.stringify(entry)}`)
}

/**
 * 装配：按 resolve 出的行序挂载全部插件，返回容器。
 * 这是**唯一的**装配代码路径——full、safe、打过 patch 的组合都从这走
 * （「同一份插件代码」的结构保证：产品差异只存在于传入的行表数据）。
 * @param resolved - resolve 的产物（校验已过；行序即挂载序）。
 * @param runtime - 运行时资源（模型适配器、执行世界、审批通道）。
 * @returns 装配好的 ctx：挂载失败时 Ctx.mount 已回滚半装效果并上抛。
 */
export function assembleBundle(resolved: ResolvedBundle, runtime: AssembleRuntime): Ctx {
  const ctx = new Ctx()
  for (const entry of resolved.entries) {
    ctx.mount(buildEntry(entry, runtime, ctx))
  }
  return ctx
}
