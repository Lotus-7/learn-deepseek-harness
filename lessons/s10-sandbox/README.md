# s10 · sandbox：沙箱与统一执行世界——本地一键换远程

> 检验标准不是「命令能跑」，是「换一个世界，跑命令的和管文件的是同一个部署，而工具一个字不用改」。

## 为什么

s09 结尾引了 dsh 的一句话：「Filesystem and subprocess providers share one execution world, so
pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks」。
当时只做了前半句的前一半：fs 是 seam，subprocess 还不在场。本课补上整个执行世界。

「执行世界」是什么：**文件和进程共享同一个部署身份**。读文件的 `read_file` 与跑命令的
`run_command` 看似两种能力，部署上却总是一起换——本地开发时都落在你的机器，远程沙箱时都
落在同一台沙箱机。dsh 用两个 seam（`ctx.fs` + `ctx.subprocess`）加一条「成对挂载」的约定
表达这一点；本课把它做成一个显式接口：

| 角色 | 本课文件 | 职责 | dsh 对应（execution world） |
|---|---|---|---|
| Service Definition | `world-service.ts` | `ExecutionWorld extends FsService` + `spawn`、`WorldErrorCode`、`world` 服务键 | packages/fs/fs + packages/subprocess/subprocess（两 seam 一世界） |
| Service Provider | `world-local.ts`、`world-sandbox.ts` | 同一契约的两种部署 | fs-local + subprocess-local（本机）；fs-e2b + subprocess-e2b（E2B 沙箱） |
| Consumer | `world-tools.ts` 的 `run_command` + s09 的三个 fs 工具 | 模型面 schema、错误补救 | tool-bash（经 shell seam）、tool-fs |
| （装配） | `index.ts` 的 `worldPlugin(...)` 行 | 显式选定世界 | cordis.yml 的 provider 行 |

**fs 面零重写。** `ExecutionWorld` 直接 `extends FsService`——s09 的三操作契约、错误分类、
测试原样成为世界的一部分；`SandboxWorld` 更进一步，把 s09 的 `createRemoteFs({ root:
'/sandbox' })` 整个拿来当虚拟 FS（它本来就是「前缀围栏 + 内存存储」），自己只加虚拟命令
解释器。这就是「复用/委托」的取舍：能复用的契约与实现绝不重写，新的代码只写新的一面
（spawn）。

**两个 provider 各带一种策略检查，都在 spawn 之前。** LocalWorld 是真机器——什么命令都能
跑，所以「哪些能跑」必须显式配置成白名单（构造参数必传，没有默认）；SandboxWorld 是进程
内虚拟世界——没有 `/etc`，所以围栏是「只认 `/sandbox/` 前缀」。为什么在事前而不是事后审
计：**事后拦下的命令已经跑过**，副作用收不回，「拒绝回喂、模型重试」救不回泄漏。dsh 的
同款立场：bash-sandbox 在 spawn 前用 `ctx.sandbox.confine()` 包好 argv，"Positive
runner-launch evidence means the command never ran"——拒绝时进程根本没启动。

**退出码与拒绝走两个通道。** `cat /sandbox/missing.md` 是命令跑了但失败（退出码 1 + stderr，
照常回喂，模型换路径）；`cat /etc/hosts` 是命令根本没跑（`WORLD_PATH_DENIED` 错误回喂，带
「改用围栏内路径」的补救语）。两类信息模型的正确反应不同，所以契约把它们分开：退出码是
`SpawnResult` 的字段，拒绝是异常。dsh 同款：进程内围栏抛结构化的 `FS_SANDBOX_DENIED`
——"an in-process fence knows exactly what it refused"，不需要从 stderr 文本猜。

**一个对象、两个服务键。** `worldPlugin(world)` 把同一个世界贡献为 `fs`（s09 的三个工具零
改动续用）和 `world`（run_command 消费）。挂上即成对，重复挂载在第一个键上就被重名检查
拦下——「fs 是沙箱、进程是本机」的错位世界在装配期就上不了台。真仓没有这层保险，靠的是
约定与决策笔记（"Providers mounted together must describe the same path namespace,
executables, processes, and terminal sessions"）；教学版用类型把这层纪律折进了一个插件。

## 跑起来

```sh
pnpm --filter @learn-dsh/s10-sandbox dev
```

不用任何 API key，三幕 + 收束（节选；本机临时目录路径因机器而异）：

```text
—— 第一幕：同一段脚本在两个世界各跑一遍 ——
世界 A：LocalWorld（真磁盘 + 真 child_process；命令白名单 echo/cat/wc/node）
  [write_file] …/learn-s10-…/mission/notes.md
    回喂 → 已写入 …（28 字符）
  [run_command] wc -l …/notes.md
    回喂 → exit 0；       3 …/notes.md
世界 B：SandboxWorld（进程内虚拟世界：虚拟 FS + 虚拟命令解释器；围栏 /sandbox）——剧本与工具一个字没换
  [run_command] wc -l /sandbox/notes.md
    回喂 → exit 0；3 /sandbox/notes.md
事件类型序列逐条同形（各 13 条，测试钉住）：
  turn/start → user/message → assistant/message → tool/call → tool/result → … → turn/end
最终回答（两世界逐字相同）：已核对：笔记共 3 行；cat 读回与写入逐字一致——集群共 47 台节点。
执行特征：spawn 各 2/2 次——世界 A 每次 spawn 都 fork 真进程（wc 的输出带真实格式与路径），
  世界 B 全部进程内解释（world-sandbox.ts 不 import child_process，零真进程）；耗时 A 177ms / B 0ms。

—— 第二幕：本机世界的白名单——拒绝发生在 fork 之前 ——
  [run_command] bash -c wc -l < …/manifest.md
    回喂 → 工具执行出错：命令 "bash" 不在本世界的白名单内（可用：echo、cat、wc、node）
    （WORLD_COMMAND_DENIED） —— 本世界只放行配置的命令白名单；请改用白名单内的命令完成目标
  [run_command] wc -l …/manifest.md
    回喂 → exit 0；       3 …/manifest.md

—— 第三幕：虚拟世界的围栏——越界路径写入被拦下 ——
  [write_file] /etc/hosts
    回喂 → 工具执行出错：路径 "/etc/hosts" 在本文件系统的根 /sandbox 之外（FS_OUT_OF_ROOT） —— …
  [run_command] cat /etc/hosts
    回喂 → 工具执行出错：命令 cat 要操作的路径 "/etc/hosts" 在本沙箱的围栏 /sandbox 之外
    （WORLD_PATH_DENIED） —— 本沙箱的命令只能操作围栏之内的路径；请改用围栏内的路径重试
  [write_file] /sandbox/hosts-backup.md
    回喂 → 已写入 /sandbox/hosts-backup.md（19 字符）
  [run_command] cat /sandbox/hosts-backup.md
    回喂 → exit 0；127.0.0.1 localhost
围栏内的虚拟 FS 清单：hosts-backup.md——越界尝试零副作用，世界里根本不存在 /etc。

—— 收束：换世界是显式的一行装配 ——
① 同时挂两个世界（fs 与进程想拆到两家）→ 服务 "fs" 已贡献（当前服务：model, sessions, tools, fs, world, agent）
② 一个对象贡献 fs 与 world 两个键：挂上即成对——「fs 是沙箱、进程是本机」的错位世界在装配期就上不了台。
```

本课新增六个文件，建议按这个顺序读：

1. `src/world-service.ts` —— Definition：`ExecutionWorld`（fs 面 = s09 契约、spawn 面的
   SpawnResult 与两码）+ `world` 服务键。退出码与拒绝的两通道约定全在契约注释里。
2. `src/world-local.ts` —— 第一个 Provider：真磁盘（`node:fs/promises`，越界 FS_OUT_OF_ROOT）
   + 真 child_process（execFile 收集 stdout/stderr）；白名单在 fork 之前。
3. `src/world-sandbox.ts` —— 第二个 Provider：**复用** s09 的 RemoteFs 当围栏 FS，只加虚拟
   命令解释器（echo/cat/wc）；路径围栏在解释命令之前，echo 的路径样参数只是文本不受限。
4. `src/world-plugin.ts` —— 一个对象贡献 `fs` + `world` 两个键：挂上即成对。
5. `src/world-tools.ts` —— Consumer：`run_command`（argv 形态、无 shell 语义），只 import
   契约；REMEDIES 按码补补救语，退出码照常渲染。
6. `src/index.ts` —— 装配器：`worldPlugin(...)` 一行换世界；三幕演示 + 收束重复装配。
7. `src/world.test.ts` —— 五组断言：同一断言集跑两遍、两个 provider 各自的策略
   （拒绝零副作用、白名单经配置传入、127 与拒绝分开）、Consumer 零感知（import 关系
   钉住 + 两世界同形）、拒绝回喂、装配显式性（重名/卸载）。

改两个地方感受一下：

- **给白名单加一条命令**：把 `index.ts` 第二幕装配行的 `allowedCommands` 加上 `'bash'`
  （`['echo', 'cat', 'wc', 'node', 'bash']`），重跑。第一次 `run_command` 从「拒绝回喂」
  变成「exit 0 + 真实 wc 输出」——bash 真上场了。白名单是纯配置：世界代码、工具代码、
  剧本一个字没改，策略行为整体切换。反过来把 `'wc'` 从白名单里删掉，第二次调用也会被
  拒——「策略即部署」在这一个数组上。
- **给 SandboxWorld 加一个虚拟命令**：在 `world-sandbox.ts` 的 `fencePaths` 命令集里加
  `'touch'`，再在 `spawn` 的 switch 里加一个 `case 'touch'`（`await fs.writeFile(args[0]!,
  '')`），然后在第三幕剧本后面加一次 `run_command {command: 'touch', args:
  ['/sandbox/touched.md']}`——虚拟世界长出了一条新命令，LocalWorld 与全部工具零改动。
  对照 dsh：给一个世界加能力是 Provider 的演进，Consumer（工具）永远无感。

## 看真码（进阶导读）

dsh 的执行世界是两个 seam 的成对组合，E2B 家族是它的远端实证：

- [docs/architecture.md 的 Capability seams 一节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#capability-seams)：
  本课标题的出处——"Filesystem and subprocess providers share one execution world, so
  pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider
  forks"。教学版一个键、真仓两个键加一条约定，读的时候把这句话当两个版本的共同不变式。
- [.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md)：
  「ctx.fs 与 ctx.subprocess 共同定义一个执行世界」的决策原文。备选方案逐条否决尤其值得
  读：「每个远端 provider 复制一份 PTY/LSP 包」被拒，因为通用 Consumer 已经拥有那些领域
  行为；「把整个 harness 搬进沙箱」被拒，因为那会拖进插件加载、凭据、模型传输、会话
  持久化——**搬走的是可变工作区，不是 harness**。
- [packages/e2b/README.md](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/e2b)：
  远端实证的全家福：`dsh-e2b`（沙箱生命周期 owner）+ `dsh-fs-e2b`（ctx.fs 适配器）+
  `dsh-subprocess-e2b`（ctx.subprocess 适配器）。关键句："The existing dsh-bash-local,
  dsh-terminal-bash, and dsh-lsp-stdio need no E2B-specific forks"——bash、终端、LSP 的
  Consumer 把执行世界操作全部委托给 ctx.fs / ctx.subprocess，挂上两个适配器，它们的可变
  工作就都进了同一个沙箱。教学版的「换 worldPlugin 一行」是它的最小化版本。
- [packages/e2b/e2b/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/e2b/e2b/src/index.ts)：
  沙箱 owner 的本意："Capability adapters await the same SDK handle, so filesystem and
  process operations inhabit one remote Linux world"——两个适配器等的是**同一个** handle，
  世界共享由此免费成立（教学版对应「一个对象两个键」）。
- [packages/subprocess/subprocess/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subprocess/subprocess/src/index.ts)：
  subprocess seam 的 Service Definition。真契约比教学版的 spawn 宽得多
  （resolveExecutable 解析可执行路径、raw/collect 两种 stdio、spawnTerminal 一个终端原语），
  但立场同款："Command defaulting, shell semantics, deadlines, protocol framing, terminal
  readiness, and presentation belong to consumers"——教学版 run_command 的 argv 形态就是
  这句话的最小实现。同文件的 `scrubbedParentEnv()` 是教学版没收的一面：凭据形状的环境
  变量绝不隐式传给子进程。
- [packages/subprocess/subprocess-local/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subprocess/subprocess-local/src/index.ts)：
  本机 Provider：detached 进程树、SIGTERM→grace→SIGKILL 升级、宿主退出时同步终结残留
  树。教学版 LocalWorld 的 execFile 只收「跑完拿结果」的 collect 语义——终止、树、环境
  清洗这些教学版从简的部分，这里都是完整契约。
- [packages/fs/fs-sandbox/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs-sandbox/src/index.ts)：
  进程内围栏的真身："The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED
  path, NOT a kernel boundary"。它拒绝时抛结构化的 `FS_SANDBOX_DENIED`——"an in-process
  fence knows exactly what it refused"；对照 bash 的内核边界拒绝要从 stderr 签名推断。
  教学版 SandboxWorld 的围栏同属进程内检查，所以也能给出精确的 WORLD_PATH_DENIED。
- [packages/shell/bash-sandbox/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/bash-sandbox/src/index.ts)：
  「拒绝在 spawn 前」的真仓样板：`ctx.sandbox.confine(['bash', '-c', command], policy)`
  在启动前把 argv 包进沙箱 runner，runner 启动失败即 `SANDBOX_UNAVAILABLE`——"Positive
  runner-launch evidence means the command never ran"。
- [packages/shell/bash-local/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/bash-local/src/index.ts)：
  Consumer 分层的另一课：bash 工具不直接是 execution world 的 Consumer，中间隔着 shell
  seam（bash 语义映射到普通 `ctx.subprocess.spawn()`）；而 "Execution policy belongs in
  `tools/pre-execute` or a sandboxing executor"——策略不在 bash 语义层。教学版把三层
  （工具→shell→subprocess）压成一层（工具→世界），省掉的每一层在真仓各有其位。
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：流式 stdout 与 raw 管道（工具边读边处理）、
终端原语（PTY 与前台进程组）、进程树终止与升级、凭据清洗的环境边界、以及 s11 的主题
——把一个受限工具集 + 私有日志的子代理放进这个世界里委派任务。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 统一执行世界 | execution world | fs 与 subprocess 共享一个部署身份；dsh 两 seam 一约定，本课一接口 |
| 沙箱 | sandbox | 把可变工作区放进受控环境；dsh 的 e2b 家族是远端实证 |
| 命令白名单 | command allowlist | LocalWorld 的策略：真机器什么都能跑，所以「能跑什么」要显式配置 |
| 路径围栏 | path fence / containment | SandboxWorld 的策略：只认 `/sandbox/` 前缀；拒绝即 WORLD_PATH_DENIED |
| 策略检查 | policy check | 在 spawn **之前**执行；事后审计收不回已发生的副作用 |
| 拒绝 / 退出码 | denial / exit code | 两个通道：拒绝是错误回喂（命令没跑），退出码是结果回喂（跑了但失败） |
| argv | argv | 命令与参数的结构化形态，不经 shell 展开；白名单只查 argv[0] |
| 进程内围栏 | in-process fence | 围栏代码与被检查路径同进程，拒绝时精确知道拒绝了什么 |
| 虚拟世界 | virtual world | SandboxWorld：内存 FS + 命令解释器，零真进程 |
| 成对挂载 | mounted together | dsh 的约定：一起挂的 provider 必须描述同一个世界 |
