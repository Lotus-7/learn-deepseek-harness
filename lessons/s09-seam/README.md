# s09 · seam：capability seam 三角色——换个 provider，整个世界跟着走

> 检验标准不是「能换实现」，是「换的实现带着自己的部署特征进场，而对话的形状一个事件不差」。

## 为什么

s08 结尾留了一条线：五件套都能换件了，但「能力」本身还没有正式的形状——model 插件换的是
适配器实例，不是「同一件事的另一种做法」。真 harness 里最常见的替换恰好是后者：文件系统
从本地换成沙箱、执行从本机换成远端、检索从一家供应商换成另一家。dsh 给这类可替换能力的
正式形状叫 **capability seam**：三个角色，一件能力。

| 角色 | 本课文件 | 职责 | dsh 对应（fs seam） |
|---|---|---|---|
| Service Definition | `fs-service.ts` | 接口、错误分类、`fs` 服务键 | `packages/fs/fs`（FileSystem + types.ts） |
| Service Provider | `fs-memory.ts`、`fs-remote.ts` | 实现同一契约，各带部署特征 | `fs-local`、`fs-sandbox`、`fs-e2b` |
| Consumer | `fs-tools.ts`（三个 defineTool 工具） | 模型面 schema、调用契约、错误呈现 | `tool-fs`（read/write/edit 工具） |
| （装配） | `index.ts` 的 `fsPlugin(...)` 行 | 显式选定 provider | cordis.yml 的 provider 行 |

**为什么「接口归调用方所有」。** 看 `fs-service.ts` 的依赖箭头：它不 import 任何 provider，
也不 import 任何工具——两边都来 import 它。这不是洁癖，是变化率的安排：契约（能力是什么）、
实现（怎么做到）、消费面（模型拿什么工具）三者因不同的理由、按不同的速度变化；把接口放进
任何一个实现里，「换实现」就会波及调用方——dsh 的 Agent Note 给出的反例正是：把本地执行器
换成沙箱执行器，结果把模型看到的工具 schema 也搅动了，尽管模型面契约根本没变。所以契约
面向**全体当前 Consumer** 设计，站在中间，谁实现它、谁消费它都与它无关。

**seam 完整性：三角色缺一不可。** 只有 Definition 是纸上契约（没有东西可运行）；只有
Provider 没有共享契约，换实现就要改遍调用点；只有 Consumer 没有 seam——它调的是具体实现，
「换 provider」退化成「改遍所有调用处」。dsh 的原话：「A package may combine roles, but
one role alone is not a seam」——包可以合并角色，角色本身不能缺席。本课三角色各自成文件，
正是为了让每一处的边界可见。

**部署差异写进契约。** 两个 provider 的差别不是「代码不同」，是**特征**不同：MemoryFs
全路径可达、零延迟；RemoteFs 只放行 `/remote/` 前缀、每次操作付一次模拟往返。特征差异里
有一类必须进契约——错误语义：越界是 `FS_OUT_OF_ROOT`，与「不存在」（`FS_NOT_FOUND`）
分开，因为模型对两者的正确反应不同（换路径重试 vs 检查拼写）。错误分类是 Definition 的
一部分，provider 抛带码的 `FsError`，Consumer 据码补「下一步怎么办」，不解析文本。

**两个世界的同形性。** 第一幕把同一任务在两个世界各跑一遍：事件类型序列逐条相同、最终
回答逐字相同，耗时特征却差两个数量级——这就是标题的意思：换 provider，特征（可达性、
延迟）整体切换，形状（对话结构）一个事件不差。

**显式组装的取舍。** 「选谁」必须是一步看得见的装配动作。本课的取舍：provider 经
`fsPlugin` 挂上 s08 的容器（贡献 `fs` 服务——于是重名贡献当场抛错、卸载即能力消失，全部
沿用 s08 机制）；三个 Consumer 工具在**执行时**经 `ctx.get('fs')` 解析服务——工具是普通
对象拿不到 ctx，所以工具工厂收容器本身（`fsTools(ctx)`）。dsh 的同构机制是 inject：Consumer
是插件、声明 `inject: ['fs']`，依赖在装配期注入。两个版本共同的红线：Consumer 里没有
`?? 默认 provider`——隐藏默认等于把部署决策偷进机制，装错了就不再响亮。

## 跑起来

```sh
pnpm --filter @learn-dsh/s09-seam dev
```

不用任何 API key，三幕 + 收束（节选）：

```text
—— 第一幕：同一任务在两个世界各跑一遍 ——
世界 A：MemoryFs（进程内 Map、全路径可达、零延迟）
  [write_file] /workspace/notes.md
    回喂 → 已写入 /workspace/notes.md（32 字符）
世界 B：RemoteFs（/remote 前缀隔离、每次操作 +40ms 模拟往返）——剧本与工具一个字没换
  [write_file] /remote/workspace/notes.md
    回喂 → 已写入 /remote/workspace/notes.md（32 字符）
事件类型序列逐条同形（各 13 条，测试钉住）：
  turn/start → user/message → assistant/message → tool/call → tool/result → … → turn/end
耗时特征：世界 A 1ms / 世界 B 124ms——远端世界每次工具往返多付一次延迟，对话形状却一个事件不差。
最终回答（两世界逐字相同）：已确认：笔记读回与写入一致——集群共 47 台节点，svc-01 过载引发级联重启。

—— 第二幕：远端世界的边界——错误作为对话回喂 ——
  [write_file] /workspace/attempt.md
    回喂 → 工具执行出错：路径 "/workspace/attempt.md" 在本文件系统的根 /remote 之外
    （FS_OUT_OF_ROOT） —— 本环境的文件系统有根边界；请改用根之内的路径重试
  [write_file] /remote/workspace/attempt.md
    回喂 → 已写入 /remote/workspace/attempt.md（6 字符）

—— 收束：选 provider 是显式的一步（装配行上选，Consumer 里没有默认）——
① 直接再挂一个 provider（忘了先卸载）→ 服务 "fs" 已贡献（当前服务：…）
② 卸载 provider 后已挂载 model、tools-session、permission、compaction、loop
   read_file 回喂 → 工具执行出错：没有叫 "fs" 的服务（当前服务：…）
   turn 照常收尾（turn/end(completed)）——能力消失被模型看见，进程不崩。
```

本课新增五个文件，建议按这个顺序读：

1. `src/fs-service.ts` —— Definition：接口 + `FsErrorCode` + `fs` 服务键，零 import——
   「接口归调用方所有」从依赖方向上就能读出来；错误语义全部写在契约注释里。
2. `src/fs-memory.ts` —— 第一个 provider：进程内 Map，目录由文件路径推导。
3. `src/fs-remote.ts` —— 第二个 provider：**组合**一个 MemoryFs 当存储，只加「围栏 +
   延迟」两件事；围栏在往返之前（注定失败的请求不付网络钱）。
4. `src/fs-tools.ts` —— 三个 Consumer 工具：只 import 契约，执行时 `ctx.get('fs')`；
   `REMEDIES` 按错误码补补救语——dsh 的 tool-fs 同款做法。
5. `src/plugin-fs.ts` —— provider 的挂载插件：装配行上显式选谁。
6. `src/index.ts` —— 装配器：`fsPlugin(...)` 一行换世界；第一幕同形性对比、第二幕
   越界回喂、收束幕重复装配与卸载。注意 BASE_TOOLS 少了 s04 的演示用 `read_file`——
   seam 上的真工具顶了它的名字（重名响亮报错替我们发现了这次换代）。
7. `src/fs-seam.test.ts` —— 四组断言：同一断言集跑两遍（接口即契约）、围栏与往返、
   Consumer 零感知（import 关系钉住 + 两世界同形）、装配显式性（重名/缺失/卸载）。

改两个地方感受一下：

- **写第三个 provider**：新建 `src/fs-readonly.ts`，实现 `FsService`——`readFile`/
  `listDir` 委托一个 `createMemoryFs()`（或预置了文件的实例），`writeFile` 抛
  `FsError('… 只读文件系统不支持写入（FS_WRITE_DENIED）', …)`（往 `FsErrorCode` 加这个码
  是合法演进：错误分类是契约的一部分）。然后在 `index.ts` 把装配行换成
  `fsPlugin(createReadOnlyFs())`——三个 Consumer、两个旧 provider、契约测试里能跑的
  断言一个字不用改，第二幕的「模型被拒后改道」剧本直接变成「只读世界」的新故事；
- **给 `FsService` 加一个 `stat` 方法看波及面**：接口加声明、两个 provider 各加实现、
  Consumer 想用它就得加第四个工具（或改 `read_file` 的输出）——对比「换 provider」的
  零波及，「改契约」是全 seam 三个角色一起动。这正是契约保持最小（只有三个方法）的
  原因：每一条都是所有 provider 必须兑现、所有 Consumer 都会依赖的承诺。

## 看真码（进阶导读）

dsh 里每个能力都是一条 seam，文件系统是教学版的原型，shell 是第二个实例：

- [docs/architecture.md 的 Capability seams 一节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#capability-seams)：
  「A seam is a swappable capability with three roles: a Service Definition declaring
  the interface, a Service Provider implementing it, and a Consumer using it,
  commonly a model-facing tool. A package may combine roles, but one role alone
  is not a seam」——以及本课标题的出处：「Seams are why one provider swap changes
  the whole product. Filesystem and subprocess providers share one execution
  world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them,
  with no provider forks.」
- [docs/capability-seams.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md)：
  生成的全仓能力图。`ctx.fs` 一行写着整个 seam：Owner 是 `fs`，Implementations 是
  `fs-local`、`fs-sandbox`、`fs-e2b`，Direct consumers 是 `tool-fs`——三列就是三角色，
  教学版的表格逐行对应。
- [packages/fs/fs/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs/src/index.ts)：
  Service Definition 的真身——`FileSystem` 抽象类 `extends Service`（`super(ctx, 'fs')`），
  `declare module` 往 Context 合并 `fs: FileSystem`。真契约比教学版多两层：先
  `resolve(path)` 成不透明的 `FsTarget`（别名共享身份、越界判据），且 Definition 上还
  挂着事件——`fs/write-intent`、`fs/edit-intent` 瀑布与 `fs/observed` 广播，策略插件
  不 import 任何实现就能拦写入（seam 的第二种扩展面，本课只收了服务面）。
- [packages/fs/fs/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs/src/types.ts)：
  契约的错误分类 FsErrorCode（`FS_NOT_FOUND`、`FS_SANDBOX_DENIED`、`FS_STALE_VERSION`……
  十三码）与 `FsError`——「backends and the policy layer raise the same codes instead
  of each inventing message strings」，教学版四码的放大版。
- [packages/fs/fs-local/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs-local/src/index.ts)：
  第一个 Provider：`LocalFileSystem` 的 `static Config` 里 `cwd` 只是相对路径的解析
  基点——「a resolution default, NOT a containment boundary」：不设围栏是它的部署特征，
  与 MemoryFs「全路径可达」同款立场。
- [packages/fs/fs-sandbox/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs-sandbox/src/index.ts)：
  第二个 Provider：`SandboxedFileSystem` **继承** LocalFileSystem，文本存储机制原封不动，
  只给两个写操作加 per-call 围栏（`workspace-write` 只放行 canonicalize 后落在 workspace
  root 内的目标，拒绝抛 `FS_SANDBOX_DENIED`）。它的 JSDoc 就是本课第二幕的注脚：
  「loading it INSTEAD OF dsh-fs-local … is the whole swap — the model-facing tools
  are untouched」。教学版 RemoteFs 用组合而不是继承做同一件事（Definition 是接口，
  没有机制载体可供继承）。
- [packages/fs/tool-fs/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs/src/index.ts)：
  Consumer 的真身：`export const inject = ['tools', 'fs', 'systemPrompt']`——注入声明
  就是「消费谁」；工具经 `ctx.fs` 执行，包文档写明「never a concrete provider」。
  同包的 `error.ts` 是教学版 REMEDIES 的原型：只给 `FS_STALE_VERSION`、
  `FS_NOT_OBSERVED` 补「re-read the file, then retry」，code 保留、原错误挂 cause。
- [packages/shell/shell/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/shell/src/index.ts)：
  另一个 seam 实例：`ShellExecutor` 抽象类（`super(ctx, 'shell')`）。它的
  `resolve(request): ShellExecSpec` 是「显式 resolve，不许藏在 run 里 `?? 默认`」的
  真仓样板（本仓约定 Explicit > implicit at package boundaries 的出处形态）；JSDoc
  写明「one implementation per context; loading a second throws」——教学版收束幕①
  的重名报错在真 Cordis 里同款。
- [.agents/notes/implemented/architecture/2026-06-13-capability-seams.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)：
  三角色决策的原始论证：契约、实现、消费面三者变化率不同，捆在一个包里会让换实现
  波及模型面契约——「接口归调用方所有」的 why。
- 本课验证版本：`0.1.0-rc.5`（见 `lesson.yaml` 的 `verifiedDshVersion`）。

dsh 在这一层回答、而本课还没回答的问题：`resolve`/`FsTarget` 的不透明身份与别名归一、
版本守卫的写契约（`FsWriteIntent`、`FS_STALE_VERSION`）、`fs/*` 事件上的策略插件
（fs-observation-policy）、以及 s10 的主题——fs 与 subprocess 共享一个 execution
world，「pointing them at a remote sandbox moves Bash, PTY, and LSP with them」。

## 术语对照

| 中文 | 英文 | 备注 |
|---|---|---|
| 能力缝 | capability seam | 三角色整体；「seam 指三件套，不是接口」 |
| 服务定义 | Service Definition | 契约 + 服务键 + 错误分类（fs-service.ts） |
| 服务提供者 | Service Provider | 契约的实现（MemoryFs / RemoteFs） |
| 消费者 | Consumer | 用能力的工具或插件（read_file 等） |
| 部署差异 | deployment difference | 同一契约下 provider 各自的特征（围栏、延迟） |
| 可达根 | root / 可达边界 | provider 的路径边界；越界报 FS_OUT_OF_ROOT |
| 错误分类 | error taxonomy | FsErrorCode：按码分支，不解析错误文本 |
| 补救语 | remedy | Consumer 给契约内错误补的「下一步怎么办」 |
| 显式组装 | explicit composition | 装配行上选 provider；Consumer 里没有 `?? 默认` |
| 同形性 | same shape | 换 provider 只换特征，事件序列与回答不变 |
| 注入声明 | inject | 真 Cordis：依赖不齐插件不加载、注销时自动卸载 |
