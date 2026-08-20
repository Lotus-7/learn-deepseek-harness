/**
 * 文件系统能力的 Service Definition：接口、词汇与错误分类——一个 seam 的第一角色。
 *
 * 这个模块**只有词汇**：接口、类型化错误、以及 `fs` 服务键的目录声明。
 * 它不 import 任何 provider（MemoryFs/RemoteFs 都实现它），也不 import 任何
 * Consumer——「接口归调用方所有」的落点：契约站在中间，两边各自靠过来。
 * dsh 同构：packages/fs/fs 的 dsh-fs 包只声明 `FileSystem` 抽象类与 types.ts 的
 * 词汇（FsTargetKey、FsErrorCode、FsError），「depending only on the vocabulary
 * the contract needs」；实现与工具住在别的包（fs-local、tool-fs）。
 *
 * seam 三角色（dsh 的 capability seam 约定，见 docs/architecture.md 的
 * Capability seams 一节）：
 *
 * | 角色 | 本课 | dsh 对应（fs seam） |
 * |---|---|---|
 * | Service Definition | 本文件：`FsService` + `fs` 键 | packages/fs/fs：`FileSystem` 抽象类 + `ctx.fs` |
 * | Service Provider | fs-memory.ts、fs-remote.ts | packages/fs/fs-local、fs-sandbox、e2b/fs-e2b |
 * | Consumer | fs-tools.ts 的三个工具 | packages/fs/tool-fs（read/write/edit 工具） |
 *
 * 三角色缺一不可：只有接口没有 provider，装配无从选起；只有 provider 没有
 * 接口，换实现就要改调用方；只有调用方没有 seam，「换 provider」就变成
 * 「改遍所有调用点」——「one role alone is not a seam」。
 */

/**
 * listDir 的一条目录项。只报名字与类型，绝不带内容——
 * 「列出不读内容」让目录列举天然有界（dsh 的 FsDirEntry 同款立场）。
 */
export interface FsEntry {
  /** 目录项名字（路径最后一段，不含分隔符）。 */
  name: string
  /** 普通文件还是目录（教学世界只有这两种）。 */
  type: 'file' | 'directory'
}

/**
 * 文件系统能力的失败分类——契约的一部分，不是实现细节。
 * provider 抛 {@link FsError} 携带其中一码；Consumer 与模型据码分支，
 * 不解析错误文本。dsh 同构：packages/fs/fs/src/types.ts 的 FsErrorCode
 * （FS_NOT_FOUND、FS_SANDBOX_DENIED……分类落在 Definition，两边共用，
 * 「backends and the policy layer raise the same codes instead of each
 * inventing message strings」）。
 */
export type FsErrorCode =
  /** 读/列的路径不存在（或写入目标不可达）。 */
  | 'FS_NOT_FOUND'
  /** 操作目标存在但不是普通文件（比如对目录 readFile / writeFile）。 */
  | 'FS_NOT_A_FILE'
  /** 列目录的目标存在但不是目录。 */
  | 'FS_NOT_A_DIRECTORY'
  /**
   * 路径在本 provider 的可达根之外——**部署差异进契约**的例子：
   * MemoryFs 的根是全世界（永不抛此码），RemoteFs 只放行 `/remote/` 前缀。
   * Consumer 无法在调用前知道某个 provider 的根在哪，所以「越界」必须与
   * 「不存在」区分开：前者模型可以换路径重试，后者可能是拼写错误。
   * dsh 同位：fs-sandbox 的 FS_SANDBOX_DENIED（围栏拒绝与不存在分开报）。
   */
  | 'FS_OUT_OF_ROOT'

/**
 * 类型化文件系统错误：message 面向人（会原样进入模型可见的回喂文本），
 * code 面向程序。dsh 对应 packages/fs/fs/src/types.ts 的 FsError
 * （extends HarnessError，携稳定 code）。
 */
export class FsError extends Error {
  /** 稳定失败码：见 {@link FsErrorCode}。 */
  readonly code: FsErrorCode

  constructor(message: string, code: FsErrorCode) {
    super(message)
    this.name = 'FsError'
    this.code = code
  }
}

/**
 * 文件系统能力的服务契约：readFile / writeFile / listDir 三个操作。
 * 路径约定：以 `/` 开头的绝对路径，`/` 分隔，根是 `/`；不合规路径按不可达
 * 处理。错误语义（provider 各自实现，语义必须一致——测试用同一断言集跑两遍）：
 *
 * - `readFile(p)`：文件存在返回全部内容；p 是目录抛 `FS_NOT_A_FILE`；
 *   p 不存在抛 `FS_NOT_FOUND`。
 * - `writeFile(p, content)`：创建或**整体替换**普通文件（无部分写），需要的
 *   父目录连同创建；p 当前是目录抛 `FS_NOT_A_FILE`。写入要么完整发生、
 *   要么抛错——调用方永远不需要清理半个文件。
 * - `listDir(p)`：p 是目录返回直接子项（按 name 稳定排序、不含内容）；
 *   p 是文件抛 `FS_NOT_A_DIRECTORY`；p 不存在抛 `FS_NOT_FOUND`。
 * - 可达性：路径在本 provider 的根之外时，任一操作抛 `FS_OUT_OF_ROOT`
 *   （且不产生任何副作用）——根是 provider 的部署事实，不在契约里定值。
 *
 * 教学取舍（与 dsh FileSystem 的差距，README「看真码」细讲）：真契约先
 * `resolve(path)` 成不透明 FsTarget 再操作（别名共享身份、防越界判据），
 * 写带版本守卫、读有字节上限；教学版收窄成三个直给路径的操作，但
 * **错误分类、稳定排序、原子替换、目录不读内容**这几条立场保留。
 */
export interface FsService {
  /**
   * 读取整个普通文件的内容。
   * @param path - 绝对路径。
   * @returns 文件的全部文本内容。
   * @throws FsError FS_NOT_FOUND / FS_NOT_A_FILE / FS_OUT_OF_ROOT。
   */
  readFile(path: string): Promise<string>
  /**
   * 原子地创建或整体替换一个普通文件，父目录不存在时连同创建。
   * @param path - 绝对路径。
   * @param content - 完整的新内容。
   * @throws FsError FS_NOT_A_FILE / FS_OUT_OF_ROOT。
   */
  writeFile(path: string, content: string): Promise<void>
  /**
   * 列出目录的直接子项，按 name 稳定排序，不读任何文件内容。
   * @param path - 绝对目录路径。
   * @returns 每个直接子项一条。
   * @throws FsError FS_NOT_FOUND / FS_NOT_A_DIRECTORY / FS_OUT_OF_ROOT。
   */
  listDir(path: string): Promise<FsEntry[]>
}

// 服务目录扩展：给 s07/s08 的 ServiceMap 加 'fs' 键。声明在 Definition
// 文件里——键与类型归契约所有，provider 贡献实例、Consumer 按键消费。
// dsh 同构：packages/fs/fs/src/index.ts 用 `declare module '@deepseek-ai/cordis'`
// 往 Context 合并 `fs: FileSystem`；教学版往迷你 ServiceMap 合并。
// 注意本文件因此不需要 import 任何东西：Service Definition 是词汇，不是机制。
declare module './cordis.js' {
  interface ServiceMap {
    /** 文件系统能力：由装配选择的 provider 贡献（见 plugin-fs.ts）。 */
    fs: FsService
  }
}
