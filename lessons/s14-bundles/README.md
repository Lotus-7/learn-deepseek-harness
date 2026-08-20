# s14 · bundles：profile 与 bundle——同一批插件组装出不同产品

> 换一个产品不该换一份代码：同一批插件、同一套装配器，叠上不同的一层数据，就是另一个产品。

## 为什么

s08 以来「装配」一直是一个手写函数：五件套逐个 `ctx.mount`、能力插件逐个传参。写一个产品没问题；
要第二个产品（比如「只读分析版」），就得复制这个函数、改几行参数——**代码分叉**。分叉的坏处不是
多几行，是从此每一处插件升级、每一个 bug 修复都要改两份。本课把装配拆成数据与代码两半：

```text
BASE（底座层）  = 行表：五件套 + world/subagent/skill/workflow 各 seam 的基线装配，中性默认值
profile（层）  = 产品形态：full（全工具 + 危险操作问人）／safe（只读 + deny + 更早压缩）
patch（层）    = 一行覆盖：改 full 的压缩阈值、或给 safe 解锁一个工具——改一行配置换策略
─────────────────────────────────────────────────────────────────────
resolveBundle(base, [profile, patch])  → 最终行表（纯函数，挂载前完成全部校验）
assembleBundle(行表, 运行时资源)        → ctx（唯一的装配代码路径）
```

**profile 是数据，不是代码分叉。** `FULL_PROFILE` 与 `SAFE_PROFILE` 是两个 JSON 可序列化的
对象（测试钉住：JSON 往返后 resolve 结果不变）；它们引用的每一行、每一个工具都来自同一份
`BASE` 与 `TOOL_CATALOG`——未覆盖的行在两个产品里是**同一个对象**（`toBe` 断言），装配出的
插件列表逐项相同（`model、tools-session、permission、compaction、world-provider、subagent、
skill、workflow、loop`）。产品差异全部落在两处数据上：名册宽窄（safe 把 delegate、
move_to_trash、start_job、collect_job 砍出模型面——schema 都不给，请求都不会发起）与
策略松紧（写/跑/删留在名册但直接 deny——模型看得见、调得动、被结构化拒绝回喂后能读懂并改道；
「砍」与「拒」是两条路，前者是不给能力，后者是给了能力但围上栅栏）。

**覆盖按 id 定位、整体替换、不深合并。** 这条语义与 dsh 逐字相同（dsh-base 的 README：
"A patch replaces whole row configs — profile overrides must restate every field a row
keeps"）。所以给 safe 解锁 write_file 的 patch 必须**整行重述** permission 行——run_command、
delete_file 的 deny 要照抄，漏写的字段不会从下层「继承」回来。不做深合并的理由是可推理：
一行配置的最终值只看一层，可以整个 dump 出来检查（dsh 的 `--dump-config` 正是这么用的）。
教学版只收 replace 一种动词；dsh 的 patch 还有 insert（插新行）与 disabled（禁行），mode
bundle 用它们加自己的行、关 base 的行。

**校验前置到挂载之前。** `resolveBundle` 是纯函数，在构造任何插件之前把配置全查完：覆盖的
行 id 必须存在、plugin 必须与目标行一致（覆盖是重述不是换插件）、名册点名的工具必须在目录、
权限规则点名的工具必须在名册（规则管不着名册外的工具）、压缩参数必须合法——错引响亮报错，
错误信息列出可用值（misconfiguration fails loud：错配置死在启动，不是跑了一半在某个工具调用上
炸）。resolve 与 assemble 分开还有一个真码理由：组合结果可以被离线计算、离线打印而不碰任何
插件——dsh 的 `composeEntries` 用与 boot 同一个 patch 算法组合层（"so composition, flag
derivation, and config dumps cannot drift from what boots"）。取舍要如实讲：dsh 的**用户**
patch 层对命中缺失行 id 只给 stderr 警告（用户文件面对版本漂移，宽容比崩溃对）；教学版收为
throw——单版本进程内，错引必然是笔误，报错比宽容好。

| 本课文件 | 职责 | dsh 对应 |
|---|---|---|
| `bundles.ts` | 三层数据（BASE / FULL / SAFE）+ 工具目录 + resolve 纯函数 | dsh-base 的 cordis.patch.yml + app-boot 的 composeEntries |
| `assemble.ts` | 行表 → 插件实例 → 按序挂载；运行时资源（model/world/askUser）注入 | boot：Loader 挂载组合出的 entry 列表 |
| `index.ts` | 四幕演示：装配对比 → full → safe → patch 翻转 | `dsh --profile <name>` 的产品意义 |
| `bundles.test.ts` | 同一剧本两种结局、patch 双向、错引报错、结构断言 | app-boot 的 profile 组合测试 |

值得点名：**运行时资源与 bundle 数据分离**。模型适配器、执行世界、审批通道由部署环境注入
（`AssembleRuntime`），profile 只声明产品决策。dsh 同款边界：组合声明「有哪些适配器」，key
从 settings/credentials 来——"Which adapters exist is composition; which providers run is
the user's settings document"（dsh-base 的行注释）。full 的规则裁到 ask 而部署没给审批通道时，
s04 的 fail-safe 生效（ask → deny）——「规则要问人」与「有没有人可问」是两件事。

## 跑起来

```sh
pnpm --filter @learn-dsh/s14-bundles dev
```

不用任何 API key，四幕（节选）：

```text
—— 第一幕：装配——同一底座（BASE 9 行），两个 profile，两份产品数据 ——
  full：名册 17 工具；规则 allow（10）、ask（7），默认 ask；压缩阈值 1200
  safe：名册 13 工具；规则 allow（10）、deny（3），默认 deny；压缩阈值 380
  插件列表一致（model、tools-session、permission、compaction、world-provider、subagent、skill、workflow、loop）——同一批插件，两个产品。

—— 第二幕：同一请求 · full profile——写与跑命令都先问人，批准后通过 ——
  审批问答 2 次：write_file、run_command（两次都批准）。

—— 第三幕：同一请求 · safe profile——写被 deny 回喂，模型改走只读路径 ——
  write_file → 守卫否决：权限拒绝：策略把 write_file 标记为 deny；如需完成目标，请改用其他工具
  最终回答  → ……我改用 list_dir 确认了现状……我没有做任何修改。

—— 第四幕：patch——一行整行重述把 write_file 从 deny 提到 ask，结局翻转 ——
  write_file  → 已写入 /sandbox/notes.md（6 字符）（经 ask 批准——翻转）
  run_command → ……权限拒绝：策略把 run_command 标记为 deny（同一行重述里照抄的 deny——没被顺带解锁）
```

第二、三幕跑的是**同一句话**——产品差异全部来自装配。第三幕的「改走只读路径」是剧本演的，
但「deny 回喂」是装配出来的：safe 的 permission 行把 write_file 裁成 deny，拒收文本经 s04 的
管线回喂模型。第四幕的翻转不需要改任何插件代码：一行 patch（整行重述）压在 safe 之上。

本课新增三个文件（bundles / assemble / bundles.test）、重写演示入口，建议按这个顺序读：

1. `src/bundles.ts` —— 先看类型（`Entry`：id + plugin 判别键 + 纯数据 config；`Override` 就是
   一行完整的 Entry；`Layer`/`Profile`），再看 `TOOL_CATALOG`（名字 → 惰性工厂，「已安装包」的
   进程内替身）、`BASE`（底座九行，中性默认——随产品变的值不写在这里）、`FULL_PROFILE` /
   `SAFE_PROFILE`（各覆盖了哪几行、为什么），最后读 `resolveBundle`：层叠算法（Map 按 id 换值、
   保持 base 行序）与五条校验，每条错误信息都带可用值清单。
2. `src/assemble.ts` —— 效果半边：`buildEntry` 的 switch（判别联合穷尽，default 是编译期哨兵）
   与 `AssembleRuntime`（数据与资源的分界）。注意它不重复 resolve 已做的校验——
   `ResolvedBundle` 类型就是「已校验」的证据。
3. `src/index.ts` —— 四幕：第一幕的三个结构断言（未覆盖行同一对象、插件列表一致、名册对比）
   是「同一批插件」的运行时证据；第四幕的 `UNLOCK_WRITE_PATCH` 整行重述是「不深合并」的现场。
4. `src/bundles.test.ts` —— 三组：resolve 层叠与错引（七条响亮报错）、同一剧本两种结局
   （含名册差异与结构断言）、patch 双向（解锁 / 收紧 / 压缩阈值）。

改两个地方感受一下：

- **写第三个 profile「dev」**：在 `bundles.ts` 里照 safe 的样子加一个 `DEV_PROFILE`——比如
  名册照抄 full、规则把 `run_command` 提成 `allow`（开发机信任命令）、`write_file` 保持
  `ask`、压缩阈值取 800。然后在 `src/index.ts` 第一幕的打印里加一行 `summaryLine('dev',
  resolveBundle(BASE, [DEV_PROFILE]))`——注意你写的是一个纯数据对象，没有一行新插件代码；
  再把第二幕的层换成 `[DEV_PROFILE]`、剧本换成「跑 `echo` 确认环境」，看命令不经审批直接执行。
- **把 patch 从放松改成收紧**：把 `src/index.ts` 里 `UNLOCK_WRITE_PATCH` 的 `write_file` 改回
  `'deny'`，同时把 `run_command` 从 `'deny'` 提到 `'ask'`——重跑第四幕：结局整个反过来
  （写被拒回喂、跑经批准通过），而第三、四幕之间你只改了一行数据。再试**只**把
  `write_file: 'ask'` 改成 `'deny'`、同时删掉 rules 里的其余条目——resolve 会告诉你整行
  重述漏字段了吗？（不会报错：你写的 rules 表就是全部，其余工具落到 `defaultDecision: 'deny'`
  上，产品比预想的更严——「不深合并」的另一面。真码同款：字段缺失不报错，靠
  `--dump-config` 检查最终行值。）

## 看真码（进阶导读）

dsh 的产品形态就是本课层数据的生产版：`A running dsh is a plugin tree composed at boot from
ordered layers`（docs/architecture.md）。导读按「底座 → 两个 mode bundle → 组合器 → CLI」：

- [packages/bundle/base/cordis.patch.yml](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/cordis.patch.yml)：
  dsh-base 真身——每个 profile 的第一层，一次 insert 全部基础行（llm、session、tools、
  persistence、sandbox、approval、permission、skill、compaction、subagent、workflow、web……）。
  两条立场与本课逐字对齐：文件头 "a row whose value differs by mode does NOT live here"
  （随模式变的值不属于 base，本课 BASE 的中性默认同款）与 "Row order carries no load
  semantics (activation is service-availability driven)"——真码行序无加载语义，教学版
  「表序即挂载序」是简化。另看它的行分组注释与 permission-presets 行：read-only /
  workspace-write / danger-full-access 三个预设——本课 full/safe 的权限差异在真码是一个
  插件行上的 presets 配置。
- [packages/bundle/headless/cordis.patch.yml](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/cordis.patch.yml)
  与 [web-app/cordis.patch.yml](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/cordis.patch.yml)：
  两个 mode bundle——SAFE_PROFILE/FULL_PROFILE 的同位物。headless 自述 "one-shot task mode
  directly over dsh-base"：按 id 覆盖 system-prompt 行（重述 persona）、disable hmr 行、
  insert 自己的 runner 行——教学版只收 replace，真码的三种动词（replace/disable/insert）都在
  这两个文件里。web-app 的文件头把覆盖语义讲到底："rows here override base rows by id …
  A patch replaces the targeted row's whole config, so each row below restates every
  key it owns"——本课「解锁 write_file 必须照抄其余 deny」的出处。
- [packages/boot/app-boot/src/profile.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/src/profile.ts)：
  组合器真身。`PROFILE_TEMPLATES`：`web = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`、
  `headless = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']`——「底座 + 一个 mode 层」
  的清单数据；`loadProfile` 对列了名却没有 `dsh.bundle` 声明的包 fail loud（"naming a
  bundle-less package as a layer is a misconfiguration, not 'no patches'"——本课 resolve
  错引报错的同一条立场）；`composeEntries` 在空 entry 列表上依序应用各层——组合、旗子推导、
  config dump 与 boot 走同一个算法，不可能漂移。真码的 profile 是 `$DSH_HOME/profiles/<name>`
  目录（package.json 声明 bundles + 用户自己的 cordis.patch.yml），bundle 是声明了
  `dsh.bundle.patch` 的 npm 包——两锚点解析、扁平 node_modules 回退，教学版的进程内表
  把这整层发行物机制省掉了。
- [apps/cli/src/args.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/args.ts)
  与 [profile-boot.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/profile-boot.ts)：
  `--profile` 旗子的产品意义。launcher 只解析自己拥有的 `--profile` / `--patch` /
  `--dump-config`，其余参数原样交给被启动的树——「挑哪个产品」与「产品内的参数」是两层；
  `--patch` 可重复、按 argv 序成为最后一层；`watchUserPatches` 让用户 patch 层改文件即热生效
  （同一叠层数据、运行中重组）。`--dump-config` 打印这台机器真会启动的树——resolve 与
  boot 不漂移的直接受益者。
- [docs/architecture.md 的 Profiles and bundles 一节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#profiles-and-bundles)：
  层序一句话："each bundle in the profile's listed order, then the profile's
  `cordis.patch.yml`, then the home-level one, then any `--patch` overlay"——本课
  `[base, profile, patch]` 的三层是它的前两跳加上尾层。
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：**发行与安装**（profile 是目录、bundle 是 npm 包，
两锚点解析与模块回退治疗——`healProfilesModuleFallback`）、**热重组**（用户 patch 层的
watch + HMR，改文件即换形态）、**patch 层的宽容**（缺失 id 警告不崩溃，为跨版本用户文件）、
**行序无关的激活**（服务可用性驱动，而非声明序）、以及 `--dump-default-config` 这类
离线检查面。顺带一提：dsh 仓 `packages/examples/` 下的示例（agent-spine-demo 等）不走
profile——它们直接用一份 cordis.yml 组装；profile 层叠属于产品 CLI（apps/cli）与
`--profile` 启动器。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 层叠组装 | layered composition | 空行表上依序应用各层；同 id 后写胜 |
| 底座层 | base layer / bundle | 所有 profile 的第一层；dsh 对应 dsh-base 的 patch |
| 产品形态 / 预设 | profile | 命名的层叠清单（dsh：目录 + package.json 的 `dsh.profile.bundles`） |
| 束 / 包 | bundle | Cordis 配置行与其代码的发行格式（npm 包 + `dsh.bundle.patch`） |
| 补丁层 | patch / overlay | 按 id 整行重述的最后一层；`--patch` 旗子按 argv 序追加 |
| 行 | entry / row | `{ id, 插件, config }`；id 是层的定位键 |
| 覆盖（整体替换） | override (whole-row replace) | 不深合并；重述保留的全部字段 |
| 名册 | roster | 模型可见的工具集合；「砍」= 不进名册 |
| 装配器 | assembler | 本课 assembleBundle；dsh 的 boot + Loader |
| 离线组合检查 | config dump | `--dump-config`：打印机器真会启动的组合树 |
