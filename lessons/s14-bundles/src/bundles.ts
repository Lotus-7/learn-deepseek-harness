import type { Ctx } from './cordis'
import type { PermissionDecision } from './permission'
import type { Tool } from './tools'
import {
  addTool,
  cachedStatsTool,
  deleteFileTool,
  echoTool,
  fetchStatsTool,
  moveToTrashTool,
  searchLogsTool,
  slowScanTool,
} from './tools'
import { fsTools } from './fs-tools'
import { worldTools } from './world-tools'
import { delegateTool } from './subagent-tools'
import { skillTools } from './skill-tools'
import { workflowTools } from './workflow-tools'
import type { Skill } from './skill-service'
import type { JobDefinition } from './workflow-service'

/**
 * 层叠组装的数据面：base 层（产品底座）+ profile 层（产品形态）+ patch 层
 * （一行覆盖）全部是**纯数据**——本文件没有一个 Plugin 实例，装配在
 * assemble.ts。这是本课的立论：**同一批插件代码，不同的一叠配置数据，
 * 就是不同的产品**。
 *
 * 与 dsh 的对应（docs/architecture.md 的 Profiles and bundles）：
 *
 * | 本课 | dsh | 差距 |
 * |---|---|---|
 * | `Entry`（id + plugin + 纯数据 config） | cordis.patch.yml 的行（id + name + config） | dsh 的 name 是 npm 包名、经 Loader 动态加载；教学版 plugin 是封闭判别联合、工厂在进程内 |
 * | `BASE` | dsh-base 的 cordis.patch.yml（每个 profile 的第一层，一次 insert 全部基础行） | dsh-base 含 persistence 行；教学版把持久层留在运行时装配位（README 讲这个取舍） |
 * | `FULL_PROFILE` / `SAFE_PROFILE` | dsh-web-app / dsh-headless 的 patch（mode bundle：按 id 覆盖 base 行） | dsh 的 mode bundle 还能 insert 新行；教学版只收 replace 一种动词 |
 * | patch 层（`Layer` 无 description） | profile 的 cordis.patch.yml、home 级 patch、`--patch` overlay | dsh 的 patch 对不存在的行 id 只 warn（用户文件面对版本漂移）；教学版收为 throw（单版本，错引必是笔误） |
 *
 * 覆盖语义与 dsh 逐字相同：**按 id 定位、整体替换、不深合并**——
 * bundle/base 的 README："A patch replaces whole row configs — profile
 * overrides must restate every field a row keeps"。所以 safe 的 permission
 * 覆盖必须重述完整规则表，给 safe 解锁 write_file 的 patch 也必须。
 */

/** 一行装配声明的判别键：底座认识的插件种类（封闭联合；加种类时同步改 assemble 的 switch）。 */
export type PluginKind =
  | 'model'
  | 'tools'
  | 'permission'
  | 'compaction'
  | 'world'
  | 'subagent'
  | 'skill'
  | 'workflow'
  | 'loop'

/**
 * 一行装配声明：dsh cordis.patch.yml 一行的同位物。
 * `id` 是层的定位键（上层按它覆盖本行），`plugin` 挑插件工厂，
 * 其余字段是那个插件的**纯数据 config**——JSON 可序列化，没有任何函数。
 * dsh 里 id 与包名解耦：同一个包可以多行不同 config（dsh-base 的
 * tool-subagent 与 tool-subagent-fork 同名包、不同 id）；教学版每插件一行，
 * 但 id 独立于 plugin 的结构照旧保留——覆盖按 id、构造按 plugin。
 */
export type Entry =
  /** model 行：贡献模型适配器。适配器实例是运行时资源（环境注入），行上无 config。 */
  | { readonly id: string; readonly plugin: 'model' }
  /** tools 行：模型面工具名册。名字到 {@link TOOL_CATALOG} 解析。 */
  | { readonly id: string; readonly plugin: 'tools'; readonly tools: readonly string[] }
  /**
   * permission 行：权限规则表（工具名或 `'*'` 通配 → 三态）+ 未匹配默认 + 会话记忆开关。
   * askUser 审批通道是运行时资源（有没有人可问取决于部署），规则是产品决策——两者分离。
   */
  | {
      readonly id: string
      readonly plugin: 'permission'
      readonly rules: Readonly<Record<string, PermissionDecision>>
      readonly defaultDecision: PermissionDecision
      readonly remember: boolean
    }
  /** compaction 行：压缩阈值与尾部窗口。摘要器是代码（deterministicSummarize），不是数据。 */
  | { readonly id: string; readonly plugin: 'compaction'; readonly threshold: number; readonly keepTail: number }
  /** world 行：贡献执行世界。世界实例是运行时资源（本机还是沙箱由部署决定）。 */
  | { readonly id: string; readonly plugin: 'world' }
  /** subagent 行：子代理能力（spawn provider）。delegate 工具是否进模型面由 tools 行的名册决定。 */
  | { readonly id: string; readonly plugin: 'subagent' }
  /** skill 行：技能注册表（底座目录见 {@link SKILLS}）。 */
  | { readonly id: string; readonly plugin: 'skill' }
  /** workflow 行：后台工作流注册表（底座目录见 {@link WORKFLOWS}）。 */
  | { readonly id: string; readonly plugin: 'workflow' }
  /** loop 行：驱动器。maxSteps 省略 = 20（s01 以来的默认）。 */
  | { readonly id: string; readonly plugin: 'loop'; readonly maxSteps?: number }

/**
 * 一条覆盖：dsh patch 行的同位物——就是一行完整的 {@link Entry}。
 * 按 id 定位目标行并**整体替换**（不深合并）；plugin 必须与目标行一致
 * （换插件种类不是覆盖，是改底座）。教学版只收 replace 这一种动词；
 * dsh 的 patch 还有 insert（插入新行）与 disabled（禁行）。
 */
export type Override = Entry

/** 一个层叠层：名字 + 覆盖集。层序决定谁压谁（同 id 后写胜）。 */
export interface Layer {
  /** 层名：进 resolve 的错误信息与装配摘要（如 `'full'`、`'patch/unlock-write'`）。 */
  readonly name: string
  /** 覆盖集，层内依序应用。 */
  readonly overrides: readonly Override[]
}

/** 一个 profile：同一底座上的一个产品形态（一个带说明的层）。 */
export interface Profile extends Layer {
  /** 一句话产品定位（装配摘要打印）。 */
  readonly description: string
}

/** 把 profile 当层用（profile 本来就是层——dsh 里 bundle 层与用户 patch 层同构）。 */
export function layerOf(profile: Profile): Layer {
  return { name: profile.name, overrides: profile.overrides }
}

/**
 * 工具目录：名册里的名字到这里解析成工具。
 * dsh 对应 Loader 按 cordis.patch.yml 行的 name（npm 包名）动态加载插件；
 * 教学版没有动态加载，这张表就是「已安装包」的进程内替身——resolve 据它
 * 校验名册（错名在装配期响亮报错），装配时惰性构造。需要 ctx 的 Consumer
 * （fs/world/skill/workflow/delegate）以 ctx 为参数：目录只声明「名字 → 怎么造」，
 * 造出来的工具执行时才解析服务（s09 的立场不变）。
 * 索引取数组项（如 `fsTools(ctx)[1]`）依赖工厂的固定返回序——见各工厂的返回列表。
 */
export const TOOL_CATALOG: Readonly<Record<string, (ctx: Ctx) => Tool>> = {
  echo: () => echoTool,
  add: () => addTool,
  delete_file: () => deleteFileTool,
  move_to_trash: () => moveToTrashTool,
  slow_scan: () => slowScanTool,
  fetch_stats: () => fetchStatsTool,
  cached_stats: () => cachedStatsTool,
  search_logs: () => searchLogsTool,
  // fsTools 返回序：read_file / write_file / list_dir。
  read_file: (ctx) => fsTools(ctx)[0]!,
  write_file: (ctx) => fsTools(ctx)[1]!,
  list_dir: (ctx) => fsTools(ctx)[2]!,
  // worldTools 返回序：run_command。
  run_command: (ctx) => worldTools(ctx)[0]!,
  // 子代理默认白名单与 s13 相同：只读两件——委派即缩小爆炸半径（s11 的立场）。
  delegate: (ctx) => delegateTool(ctx, { defaultTools: ['read_file', 'list_dir'] }),
  // skillTools 返回序：list_skills / load_skill。
  list_skills: (ctx) => skillTools(ctx)[0]!,
  load_skill: (ctx) => skillTools(ctx)[1]!,
  // workflowTools 返回序：start_job / collect_job。
  start_job: (ctx) => workflowTools(ctx)[0]!,
  collect_job: (ctx) => workflowTools(ctx)[1]!,
}

/** 底座自带的技能目录（s12 复制前进；装配数据，本课不是 profile 旋钮）。 */
function csvSkill(): Skill {
  return {
    name: 'csv',
    description: '结构化表格（CSV）数据的检查与统计规程',
    instructions: '[skill: csv] 处理 CSV 前先核对列结构与行数，结论只引用核对过的数字。',
    tools: [],
  }
}

/** 底座自带的技能清单。 */
const SKILLS: readonly Skill[] = [csvSkill()]

/** 底座自带的工作流清单（s12 的 summary-report 位保留：注册表在场，剧本不启动）。 */
const WORKFLOWS: readonly JobDefinition[] = [
  {
    kind: 'summary-report',
    description: '后台汇总一个数据目录（本课不启动，注册表在场证明复制前进完整）',
    run: async function* (input: string) {
      yield `（未启动）读取数据目录清单：${input}`
      return '（未启动）'
    },
  },
]

export { SKILLS, WORKFLOWS }

/**
 * 底座（base layer）：所有 profile 共享的行表——「产品底座」的声明。
 * 对照 dsh-base 的 cordis.patch.yml：每个 profile 的第一层，一次声明全部
 * 基础行；行上的取值是**中性默认**——dsh-base 原文："Mode-specific rows
 * appear below only with shared plugin identity and neutral defaults"。
 * 随产品形态变的值（名册宽窄、危险操作怎么裁、压缩多激进）不写在 base，
 * 由每个 profile 整行重述。base 的中性取值：全量名册（dsh-base 装全部
 * 工具行）、空规则表 + 默认 ask（dsh 的 approval policy 'ask' 同位——
 * 未匹配的工具交给人，不默默放行也不默默挡死）、基准压缩阈值。
 * 行序即挂载序（教学版约定；dsh 里行序无加载语义，激活由服务可用性驱动）。
 */
export const BASE: readonly Entry[] = [
  { id: 'model', plugin: 'model' },
  { id: 'tools', plugin: 'tools', tools: Object.keys(TOOL_CATALOG) },
  { id: 'permission', plugin: 'permission', rules: {}, defaultDecision: 'ask', remember: true },
  { id: 'compaction', plugin: 'compaction', threshold: 1200, keepTail: 4 },
  { id: 'world', plugin: 'world' },
  { id: 'subagent', plugin: 'subagent' },
  { id: 'skill', plugin: 'skill' },
  { id: 'workflow', plugin: 'workflow' },
  { id: 'loop', plugin: 'loop' },
]

/** 只读直通类工具：无外部效果，两个 profile 都 allow。 */
const READ_ONLY_TOOLS = [
  'echo',
  'add',
  'read_file',
  'list_dir',
  'search_logs',
  'fetch_stats',
  'cached_stats',
  'slow_scan',
  'list_skills',
  'load_skill',
] as const

/**
 * full profile：交互式完整产品——对照 dsh-web-app（在 base 之上开全部面）。
 * 全工具在场（不覆盖 tools 行，用 base 名册）；有外部效果的工具一律 ask
 * （危险操作问人），只读工具直通；压缩用 base 基准阈值（不覆盖 compaction
 * 行——「默认压缩阈值」就是不重述）。审批通道由运行时注入（演示给剧本
 * 化的批准者）；通道缺失时 permission 的 fail-safe 生效（ask → deny）。
 */
export const FULL_PROFILE: Profile = {
  name: 'full',
  description: '交互式完整产品：全工具在场，危险操作问人（ask），基准压缩阈值',
  overrides: [
    {
      id: 'permission',
      plugin: 'permission',
      rules: {
        ...Object.fromEntries(READ_ONLY_TOOLS.map((name) => [name, 'allow' as const])),
        write_file: 'ask',
        run_command: 'ask',
        delete_file: 'ask',
        move_to_trash: 'ask',
        delegate: 'ask',
        start_job: 'ask',
        collect_job: 'ask',
      },
      defaultDecision: 'ask',
      remember: true,
    },
  ],
}

/**
 * safe profile：只读分析产品。三处覆盖，三种裁法：
 *
 * 1. **名册砍除**（tools 行重述）：delegate、move_to_trash、start_job、
 *    collect_job 不进模型面——委派、后台作业、可恢复清理在只读产品里没有
 *    意义，schema 都不给（模型连请求都不会发起）。对照 dsh：mode bundle
 *    对 base 行 insert/disabled 的裁法。
 * 2. **门上拒绝**（permission 行重述）：write_file / run_command / delete_file
 *    留在名册但直接 deny——模型面对「写一个文件」的请求时会尝试 write_file，
 *    收到「权限拒绝：策略把 write_file 标记为 deny」比「没有叫 write_file
 *    的工具」语义清楚得多（是本部署禁止，不是拼错名字），模型能读懂并改道。
 *    默认裁决 deny：未匹配的一律不放行（fail-closed，s04 三约定的收紧版）。
 * 3. **更早压缩**（compaction 行重述）：阈值 380 远低于 base 的 1200——
 *    只读分析产品常翻长日志，宁可更早丢细节保窗口。
 */
export const SAFE_PROFILE: Profile = {
  name: 'safe',
  description: '只读分析产品：委派与后台砍出名册，写/跑/删直接 deny，更早压缩',
  overrides: [
    {
      id: 'tools',
      plugin: 'tools',
      tools: [...READ_ONLY_TOOLS, 'write_file', 'run_command', 'delete_file'],
    },
    {
      id: 'permission',
      plugin: 'permission',
      rules: {
        ...Object.fromEntries(READ_ONLY_TOOLS.map((name) => [name, 'allow' as const])),
        write_file: 'deny',
        run_command: 'deny',
        delete_file: 'deny',
      },
      defaultDecision: 'deny',
      remember: false,
    },
    { id: 'compaction', plugin: 'compaction', threshold: 380, keepTail: 4 },
  ],
}

/** resolve 的产物：最终行表 + 装配摘要（演示与测试直接读的面）。 */
export interface ResolvedBundle {
  /** 最终行表（按 base 声明序——覆盖换值不换位；未覆盖行是 base 的原对象引用）。 */
  readonly entries: readonly Entry[]
  /** tools 行解析出的最终名册。 */
  readonly roster: readonly string[]
  /** permission 行的最终配置。 */
  readonly permission: {
    readonly rules: Readonly<Record<string, PermissionDecision>>
    readonly defaultDecision: PermissionDecision
    readonly remember: boolean
  }
  /** compaction 行的最终配置。 */
  readonly compaction: { readonly threshold: number; readonly keepTail: number }
  /** 应用过的层名（base 起）：错误信息与装配摘要用。 */
  readonly layers: readonly string[]
}

/** 报错辅助：拼「可用键」清单进错误信息（misconfiguration fails loud——错要错得能修）。 */
function list(names: readonly string[]): string {
  return names.length > 0 ? names.join('、') : '（无）'
}

/**
 * resolve：把 base 与层叠的覆盖集合成最终行表，**在挂载任何插件之前**完成
 * 全部校验（misconfiguration fails loud 的前置版——错配置死在装配期，
 * 而不是跑了一半在某个工具调用上炸）。
 *
 * 校验清单（每条都是响亮报错，信息带可用值）：
 *
 * 1. 覆盖的 id 必须在 base（或前层）已声明；
 * 2. 覆盖的 plugin 必须与目标行一致（换插件种类是改底座，不是覆盖）；
 * 3. 名册里的每个工具名必须在 {@link TOOL_CATALOG}；
 * 4. 权限规则的每个键（`'*'` 除外）必须在最终名册——规则管不着名册外的工具；
 * 5. 压缩阈值必须为正、尾部窗口至少 1 条。
 *
 * 层序语义：层依序应用，同 id 后写胜——dsh 原文（architecture.md）：
 * "each bundle in the profile's listed order, then the profile's
 * cordis.patch.yml, then the home-level one, then any `--patch` overlay"。
 *
 * @param base - 底座行表（教学版恒为 {@link BASE}；参数化是为测试能构造坏底座）。
 * @param layers - 层叠层（profile 与 patch 同构，依序应用）。
 * @returns 最终行表与装配摘要；未覆盖行保留 base 的原对象引用（结构断言用）。
 * @throws 上述任一校验失败（错误信息含层名与可用值清单）。
 */
export function resolveBundle(base: readonly Entry[], layers: readonly Layer[]): ResolvedBundle {
  const byId = new Map(base.map((entry) => [entry.id, entry]))
  for (const layer of layers) {
    for (const override of layer.overrides) {
      const target = byId.get(override.id)
      if (target === undefined) {
        throw new Error(
          `层 "${layer.name}" 覆盖了底座里不存在的行 "${override.id}"（可用行：${list([...byId.keys()])}）` +
            '——错引的覆盖静默丢掉比报错危险得多，装配期直接拒绝',
        )
      }
      if (target.plugin !== override.plugin) {
        throw new Error(
          `层 "${layer.name}" 对行 "${override.id}" 的插件种类不符：行是 "${target.plugin}"，覆盖声明 "${override.plugin}"` +
            '——覆盖是同一行的重述（换 config），不是换插件；要换插件种类，改底座',
        )
      }
      byId.set(override.id, override)
    }
  }
  // 覆盖换值不换位：行序保持 base 声明序（教学版行序即挂载序）。
  const entries = base.map((entry) => byId.get(entry.id)!)

  const toolsRow = entries.find((entry) => entry.plugin === 'tools')
  if (toolsRow === undefined || toolsRow.plugin !== 'tools') {
    throw new Error(`底座缺 "tools" 行（当前行：${list(entries.map((entry) => entry.id))}）——没有名册就不是产品`)
  }
  for (const name of toolsRow.tools) {
    if (!(name in TOOL_CATALOG)) {
      throw new Error(
        `行 "${toolsRow.id}" 的名册点名了目录里没有的工具 "${name}"（目录：${list(Object.keys(TOOL_CATALOG))}）`,
      )
    }
  }

  const permissionRow = entries.find((entry) => entry.plugin === 'permission')
  if (permissionRow === undefined || permissionRow.plugin !== 'permission') {
    throw new Error(`底座缺 "permission" 行（当前行：${list(entries.map((entry) => entry.id))}）`)
  }
  for (const key of Object.keys(permissionRow.rules)) {
    if (key !== '*' && !toolsRow.tools.includes(key)) {
      throw new Error(
        `行 "${permissionRow.id}" 的规则点名了名册外的工具 "${key}"（名册：${list(toolsRow.tools)}）` +
          '——规则管不着名册外的工具；要么名册收下它，要么删掉这条规则',
      )
    }
  }

  const compactionRow = entries.find((entry) => entry.plugin === 'compaction')
  if (compactionRow === undefined || compactionRow.plugin !== 'compaction') {
    throw new Error(`底座缺 "compaction" 行（当前行：${list(entries.map((entry) => entry.id))}）`)
  }
  if (compactionRow.threshold <= 0 || !Number.isFinite(compactionRow.threshold)) {
    throw new Error(`行 "${compactionRow.id}" 的压缩阈值必须是正数，实际 ${compactionRow.threshold}`)
  }
  if (compactionRow.keepTail < 1 || !Number.isInteger(compactionRow.keepTail)) {
    throw new Error(`行 "${compactionRow.id}" 的尾部窗口必须是 ≥1 的整数，实际 ${compactionRow.keepTail}`)
  }

  return {
    entries,
    roster: [...toolsRow.tools],
    permission: {
      rules: { ...permissionRow.rules },
      defaultDecision: permissionRow.defaultDecision,
      remember: permissionRow.remember,
    },
    compaction: { threshold: compactionRow.threshold, keepTail: compactionRow.keepTail },
    layers: ['base', ...layers.map((layer) => layer.name)],
  }
}
