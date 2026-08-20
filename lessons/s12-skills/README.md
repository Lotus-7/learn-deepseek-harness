# s12 · skills：技能系统与后台工作流

> 技能让模型「带艺上岗」，后台工作流让慢活「不挡道」——前者把规程与工具打包成一个可加载的单元，后者把「启动」与「取回」拆成两个不阻塞的动作。

## 为什么

到 s11 为止，模型的能力面在装配时就定死了：名册里有哪些工具、上下文里有什么指令，全部
在 `assemble(...)` 那几行里。但真实的 agent 经常需要**中途长出能力**：用户丢来一份 CSV，
模型此刻既没有「怎么处理 CSV」的规程，也没有「检查列结构」的工具。技能（skill）就是
这个可加载的能力单元：

```text
Skill = { name, instructions, tools? }
         名字     规程正文      可选附加工具
```

**技能为什么是「规程 + 工具」的组合，而不是只有提示词？** 纯 instructions 的技能只能让
模型「说得对」：你可以写「统计前必须核对列结构」，但若没有核对工具，这句规程就是空话
——模型只能凭空猜列名。规程规定动作的顺序与判据，工具提供动作本身；两者打包在一起，
加载一次，「知道怎么做」和「做得到」同时生效。本课的 csv 技能就是完整样本：规程第 2 条
写着「先用 csv_inspect 确认列结构与行数」，csv_inspect 这个工具就随同一个 Skill 对象
注册进名册——加载前模型调不到它（名册里响亮报错），加载后下一步请求就能用。

加载的注入语义是 s03 规矩的直接延伸：**模型看得见 ⟺ 已落账**。规程不是 `load_skill`
回喂完就消失的一次性文本，它落成一条 `system/message` 事件，从此每一步的派生历史里
都在场——技能是「当前生效的规程」，不是「曾经读过的一份文档」。这里有一个必须讲清的
**与压缩的交互**：s06 的压缩会把头部消息交给摘要器，若规程被划进头部，摘要器就成了
有权改写规程的人——本课的取舍是**规程豁免**：头部里的 system 消息不进摘要输入、不计
入被替代条数，压缩后原位保留。理由不是技术困难，是职责边界：摘要器被授权改写「发生过
的事实」，没有被授权改写「应当遵守的规程」。（dsh 的同位立场：摘要器前缀复用会话自己
的 system prompt，system 从不进被替换的表面。）

还有一条容易漏的边界：**技能扩的是能力面，权限面不自动跟扩**。csv_inspect 不在装配期
的权限表里，首次调用落入默认 `ask`，经审批放行后由会话记忆接管——演示里这件事真实
发生一次。工具「存在」与工具「被允许」是两个独立的事实，技能带来的新工具默认要人点头。

后台工作流（background workflow）回答另一个问题：**慢活不该挡道**。s11 的 delegate
是阻塞委派——父等子跑完才继续，适合「结论是下一步的前提」的强依赖。但有一类工作是
弱依赖：「给这批数据出一份汇总报告」与「我正在统计的数字」互不等待，谁先完成都行。
这类工作的正确形状是 `start_job` / `collect_job` 分离：

- `start_job` 只**登记**：返回 job id 立即继续，主循环拿回控制权接着干；
- `collect_job` **取快照**：未完成时拿到进度（不阻塞，稍后再来），终态时拿到结果。

为什么必须是两个工具？一个工具做不到这件事：阻塞等完就退化成 delegate（主循环被
占住），不等完就没法交付结果。分离后「慢任务」与「主任务」在时间上重叠，代价只是模型
多一次 collect 往返。job 内部是一个小状态机 `pending → running →（done | failed）`：
登记后未开工（pending）、开工未收尾（running，progress 叙述已走步骤）、正常收尾
（done，带 result）、某步抛错（failed，带 error——**failed 是终态快照不是异常**，
collect 永远拿快照）。推进机制是本课的一个刻意简化：每条 `tool/result` 事件落账，
全部活 job 各走一拍——「主对话每完成一件实事，后台推进一步」，进度与主循环的实际
工作量对齐，也因此**完全确定可测**（数剧本里的 tool/result 就知道 job 走到哪一步）。

| 角色 | 本课文件 | 职责 | dsh 对应 |
|---|---|---|---|
| Service Definition | `skill-service.ts` | `Skill` 词汇、`SKILL_*` 错误码、`skills` 键 | packages/skill/skill（SkillRegistry） |
| Service Provider | `skill-plugin.ts` | 技能清单收编、目录、加载三连（工具→规程） | packages/skill/skill-filesystem（目录扫描 provider） |
| Consumer | `skill-tools.ts` | `list_skills` / `load_skill` | packages/skill/tool-skill（catalog + `skill` 工具） |
| Service Definition | `workflow-service.ts` | `JobStatus` 状态机、`JobSnapshot`、`workflows` 键 | packages/workflow/workflow（WorkflowEngine） |
| Service Provider | `workflow-plugin.ts` | job 注册表、事件驱动推进 | packages/workflow/workflow-worker-thread（worker 线程引擎） |
| Consumer | `workflow-tools.ts` | `start_job` / `collect_job` | packages/jobs/tool-jobs（`job_output` 等收集工具） |

两处对复制基线的修订值得点名：**loop 每步重取工具 schema**（原版 turn 开始取一次）——
技能在 turn 中途往名册加工具，下一步请求就要看得见；**`system/message` 事件**（ChatMessage
的 system 角色从 s01 起就留着，本课第一次用）——投影、压缩豁免、幂等判据全部从事件的
判别分支出发。

## 跑起来

```sh
pnpm --filter @learn-dsh/s12-skills dev
```

不用任何 API key，一幕主流程 + 收束（节选）：

```text
—— 第一幕：load_skill 一次带来规程（上下文）与工具（名册）——
  [list_skills]
    回喂 → 可用技能目录（加载后才生效）：
    回喂 → - csv：结构化表格（CSV）数据的检查与统计规程
  [load_skill] name=csv
    回喂 → 技能 csv 已加载：规程已注入 system 段，此后每一步都生效。
    回喂 → 附带工具已注册进名册：csv_inspect（下一步请求即可调用）。
  [start_job] kind=summary-report input=/sandbox/data
    回喂 → 已登记后台 job job-1（summary-report）：状态 pending，主对话每完成一件工具实事它就推进一步……
  [list_dir] path=/sandbox/data
    回喂 → 文件  regions.csv / 文件  sales.csv
  [csv_inspect] path=/sandbox/data/sales.csv
    回喂 → /sandbox/data/sales.csv：3 列（date、region、amount），数据行 5 行（不含表头）
  [collect_job] id=job-1
    回喂 → job job-1（summary-report）：running（后台进行中，本次 collect 不阻塞）——已完成的步骤：……
  [collect_job] id=job-1
    回喂 → job job-1（summary-report）：done——最终结果：
    回喂 → 汇总报告：/sandbox/data 共 2 个数据文件、8 个数据行（不含表头）；区域分布 north×2……
名册差异：加载前 17 个工具；加载后 18 个——新增：csv_inspect
落账与投影：system/message 事件 1 条 → 派生历史 system 消息 1 条（首行：[skill: csv]）
权限面：技能运行时带来的 csv_inspect 不在装配期权限表里 → 首次调用落入默认 ask，经审批放行……
job 终态：job-1（summary-report）status=done，走过 5 个进度步骤；主对话期间它从未阻塞任何一步。
```

job 的两段式 collect 是精确对齐出来的：后台工作流共 6 步（5 个进度 + 1 个 return），
主对话在 start 之后落了 4 条 tool/result（start_job 自己 + list_dir + 两次 csv_inspect，
各推 1 拍），第 5 拍由第一次 `collect_job` 触发（还差一步 → 回喂 running），它自己的
tool/result 落账补上第 6 拍（return → done），第二次 collect 拿到结果。

本课新增六个文件，建议按这个顺序读：

1. `src/skill-service.ts` —— Definition：`Skill`（规程 + 可选工具）、`SkillCatalogEntry`
   （目录只报名与简介——全文要加载才给）、`skills` 服务契约。文件头讲「为什么 dsh 的
   技能没有 tools 字段」（真仓的「手」以资源目录里的脚本存在，工具注册走独立的
   tools seam）。
2. `src/skill-plugin.ts` —— Provider：技能清单收编（重名装配错误）、目录排序、加载的
   **顺序**（附加工具先注册——冲突在注入规程之前判定，零副作用；同名同对象视为本技能
   此前注册的，幂等重载不误伤）、规程后注入（幂等判据读日志，不另设标志）。
3. `src/skill-tools.ts` —— Consumer：`list_skills`（目录）与 `load_skill`（加载）。
   REMEDIES 模式：`SKILL_UNKNOWN` 补「先查目录」、`SKILL_TOOL_CONFLICT` 补「查装配」。
4. `src/workflow-service.ts` —— Definition：`JobStatus` 状态机、`JobSnapshot`（纯数据，
   终态字段只在对应终态出现）、`JobWorkflow`（async generator：yield 进度、return 结果）、
   三个设计决定的完整理由（生成器形态、start/collect 分离、结果从状态机读不从
   Promise 读）。
5. `src/workflow-plugin.ts` —— Provider：job 注册表、推进器（`advance` 的在途锁——
   tick 与 collect 并发时「一次 collect 至多一拍」不被破坏）、推进源（session/event
   监听里筛 tool/result）。为什么监听 emit 事件做推进不算越界：推进改的是 job 注册表
   自己的状态，不改写任何会话事实——把会话事件流当时钟，是教学版用共享事件泵换掉
   真线程的取舍。
6. `src/workflow-tools.ts` —— Consumer：`start_job` / `collect_job` 与回喂三态渲染。
7. `src/index.ts` —— 装配器与演示：csv 技能（规程 + csv_inspect）、summary-report
   工作流（6 步精确对齐）、审批剧本、名册/落账/两段式 collect 的硬断言。
8. `src/skills.test.ts` / `src/workflow.test.ts` —— 两组断言：规程落账与投影、名册
   差异与下一步可见、未知名/冲突响亮回喂、幂等重载、压缩并存（规程豁免）；状态机
   各态、collect 三态、失败路径、推进对齐、终态幂等、装配防线。

改两个地方感受一下：

- **自己写第二个技能**：照 `csvSkill(ctx)` 的样子在 `index.ts` 写一个纯规程技能
  `writeup`（`instructions` 定「报告必须三段：结论、口径、数字来源」，不带 tools），
  把它加进 `skillPlugin([csvSkill(ctx), writeupSkill])`，再在剧本开头插一步
  `load_skill({ name: 'writeup' })`。三个观察点：`list_skills` 的目录多了一行；
  加载后派生历史里有**两条** system 消息（各管各的规程，互不覆盖）；它没有附带工具，
  回喂里「该技能没有附带工具」——「规程 + 工具」的后一半是可选的，纯规程技能同样合法。
- **把 job 推到失败路径看 collect 语义**：在 `summaryReportWorkflow` 的第 4 个
  yield（「组装报告草稿」）之前插一行 `throw new Error('上游数据缺失')`，重跑。
  第一次 collect 拿到的仍是 running（失败还没发生），它的 tool/result 落账推进到
  抛错的那一步——job 落 `failed`，第二次 collect 回喂的是 `failed——后台步骤抛错：
  上游数据缺失`，**不是**工具错误：取回「失败」这个事实是 collect 的成功。对照
  `workflow.test.ts` 的 failed 用例，两种终态在快照字段上的差别（result vs error）
  就是状态机的全部输出面。

## 看真码（进阶导读）

dsh 的技能与工作流各是一个 capability family，本课是两者的教学投影——注意三处刻意的
形态差：真仓技能**没有工具字段**、注入**不走 system 消息**、工作流工具**前台等待**。

- [packages/skill/README.md](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/skill)
  的家族表：`skill/`（定义 `ctx.skills`）、`skill-filesystem/`（本地目录 provider）、
  `skill-badge/`（打包技能）、`tool-skill/`（目录发布 + 模型面 loader）。家外的定位：
  "This capability remains outside the core control spine and can use local, embedded,
  or remote providers without changing the model-facing contract"——本课把 provider 折叠
  成装配数组，模型面契约（目录 + 加载）保持同形。
- [packages/skill/skill/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill/src/index.ts)：
  SkillRegistry 的真身。`registerProvider`（provider 注册进 scope 层、重名抛错——本课
  装配数组的重名检查是它的退化形态）、`register`（runtime 技能）、`list`/`snapshot`
  （目录快照带 complete 标志——不完整的发现不缓存）、`get`（按名加载正文、名字语法
  校验 `SKILL_NAME`）、`renderSkillContent`（`<skill_content name>` + `<skill_resources>`
  + `<skill_instructions>` 的 canonical 包装——loader 结果与用户手势注入共用同一种
  呈现）、`skills/change` 事件（目录失效通知，本课没有的动态目录层）。
- [packages/skill/skill-filesystem/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/src/index.ts)：
  本地文件 provider：project/user/custom/bundled 四类根（rank 决定同名胜负）、YAML
  frontmatter（name/description/whenToUse/invocation/metadata）+ Markdown 正文、
  chokidar watch 目录热更新（`observeHostMutation` 在模型写文件后主动失效缓存）。
  教学版的「技能从装配数组来」在这里换成「技能从磁盘目录来」，`Skill` 的词汇不变。
- [packages/skill/tool-skill/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/src/index.ts)：
  模型面真身，与本课差异最大的文件。`skill` 工具加载正文（结构化 output + render 成
  `<skill_content>` 块）；**目录不是工具而是注入**——agent/pre-step 瀑布里把
  `<available_skills>` 目录作为带 `skill-catalog` source 的 **user message** 注入对话，
  digest 变了才重发布；用户 `/name` 手势（`SKILL_GESTURE` 的词边界匹配）触发
  `skill-invocation` source 的注入。真仓不把技能放进 system 消息：system prompt 由
  systemPrompt 服务每步组装（docs/architecture.md 的 Turn flow），技能注入走带
  source 元数据的 user message——transcript 消费者靠元数据识别注入，不靠重新解析
  模型可见文本。教学版没有请求级组装层与 source 机制，选 system 角色承载规程，
  「角色即语义」是简化，也是与真码的分水岭。
- [packages/workflow/README.md](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/workflow)
  的家族表：`workflow/`（定义 `ctx.workflowEngine`）、`workflow-worker-thread/`
  （worker 线程引擎）、`tool-workflow/`（通用模型面工具）、`tool-ralph/`（固定策略
  工具）。定位一句话："runs model-authored orchestration workflows over subagents"。
- [packages/workflow/workflow/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow/src/index.ts)：
  Service Definition 真身：`WorkflowEngine.start(request) → WorkflowRun`、
  `WorkflowError`（每个 code 都是 fatal，组合子必须传播而不是吞成 per-item null）、
  六个 `workflow/*` 观察事件（start/phase/log/agent-start/agent-end/end——"observe-only
  lifecycle events never expose run control"，观察者拿得到叙述，拿不到控制权）。
- [packages/workflow/workflow/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow/src/types.ts)
  与 [runtime-types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow/src/runtime-types.ts)：
  结果词汇——`WorkflowStopReason`（completed/cancelled/error；本课 done/failed 是它的
  教学两支，没有取消通道）、`WorkflowResult`（value 只在 completed 有意义）、
  `WorkflowRun`（"result never rejects; consumers may cancel and must call idempotent
  dispose()"——本课 JobSnapshot「从状态机读不从 Promise 读」是同一立场的纯数据版）。
- [packages/workflow/workflow-worker-thread/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow-worker-thread/README.md)：
  引擎 provider：每 run 一个 Node worker 线程，模型写的脚本在 `node:vm` 上下文里跑、
  `agent()` 桥回宿主的 subagent seam。"The split has one primary purpose: a synchronous
  script loop cannot block the harness event loop, and a script that ignores cancellation
  can be terminated with its worker. It is not a security sandbox."——本课的事件驱动
  推进是它的零线程替身：确定性换来的是没有真并行，也没有 terminate 兜底。
- [packages/workflow/tool-workflow/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/tool-workflow/README.md)：
  模型面工具的现状与边界，其中一句与本课构成直接对照："The parent turn blocks until
  the whole workflow settles — **there is no background start/poll API**, and
  cancellation discards partial output as an error"。真仓的 `workflow` 工具是前台等待；
  本课的 start/collect 分离是它明示 deferred 的方向。
- [packages/jobs/README.md](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/jobs)：
  start/collect 语义的现役真码：`ctx.jobs` 的 owner-fenced 后台 job 注册表（"one
  owner-isolated background-job protocol for observation, cancellation, waiting, and
  completion notices"），模型面 `job_output` / `job_list` / `job_kill`（packages/jobs/
  tool-jobs）。教学版 collect 的「未完成不阻塞」、终态 first-wins、快照即账本，分别
  对应这里的等待语义、settlement 规则与 snapshot 契约。
- [docs/architecture.md 的 Where new behavior goes 一节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#where-new-behavior-goes)：
  "Add background work | register on `ctx.jobs`; `job_*` tools collect or stop it"——
  后台工作在真仓的落点是 jobs seam，不是 workflow 引擎；两条线各自演化。
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：技能的**多 provider 分层与热更新**
（scope 层合并、rank 决胜、目录变更失效重发）、**资源目录**（resourceBase 指向技能
自己的文件，技能正文指示模型按需加载——「规程 + 资源」是真仓的组合形态）、**用户
手势与调用面策略**（`/name` 直呼、modelInvocable/userInvocable 两面开关）、工作流的
**模型写脚本**（meta 校验、agent/parallel/pipeline 编排原语、worker 线程真并行与
terminate）、以及 **取消与销毁**（cancel/dispose 的宽限期与强杀——本课连取消通道
都没有，failed 与 done 之外没有第三种终态）。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 技能 | skill | 规程 + 可选附加工具的可加载能力单元；dsh 是 instructions + 资源目录（无工具字段） |
| 规程 | instructions | 加载后持续生效的指令正文；dsh 的 SkillDefinition.content 同位 |
| 目录 | catalog | 技能的路由面（名 + 简介）；dsh 经 agent/pre-step 注入，本课是 list_skills 工具 |
| 技能加载 | skill loading | 注入规程（system/message 事件）+ 注册附加工具；dsh 的 `skill` 工具只回正文 |
| 规程豁免 | instructions exemption | 压缩不把 system 消息划进被摘要替代的头部——摘要器只改写事实 |
| 附加工具 | skill-bundled tools | 随技能加载注册进名册的工具；教学版独有，dsh 的「手」是资源目录里的脚本 |
| 后台工作流 | background workflow | 登记后异步推进的工作单元；dsh 的 workflow 引擎 + jobs 注册表两条线 |
| 工作流定义 | job definition / kind | 注册表里静态登记的工作流种类；dsh 的 run 自带 meta 与脚本 |
| 登记 | start | 创建 pending 快照并立即返回——不推进、不执行 |
| 收集 | collect | 取快照 + 顺手推一步；未完成不阻塞，终态拿 result/error |
| 状态机 | job status | pending → running →（done \| failed）；终态 first-wins |
| 进度叙述 | progress | 工作流 yield 的步骤叙述行；dsh 的 workflow/log 事件同位 |
| 推进 | advance / tick | 让活 job 走一拍；本课挂在 tool/result 落账上（事件驱动的惰性推进） |
| 工作流引擎 | workflow engine | 执行编排脚本的 provider；dsh 用 worker 线程，本课用生成器 + 事件泵 |
| 阻塞委派 / 异步取回 | foreground vs start/collect | delegate 等完（强依赖）与 start/collect 分离（弱依赖）的分野 |
