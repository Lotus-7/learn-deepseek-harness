import { FsError, type FsEntry, type FsService } from './fs-service'

/**
 * MemoryFs：进程内 Map 实现的文件系统 provider——seam 的第二个角色之一。
 *
 * 可达根是「全部路径」（永不抛 FS_OUT_OF_ROOT），没有延迟、没有隔离：
 * 同进程读写，拿来即得。目录不单独存——由已存文件的路径推导（writeFile
 * 连建父目录的契约因此免费成立）。dsh 对应 packages/fs/fs-local 的
 * LocalFileSystem：宿主文件系统的直通实现，`static Config` 的 cwd 只是
 * 相对路径的解析基点，「a resolution default, NOT a containment boundary」
 * ——不设围栏正是它的部署特征。
 * @returns 实现完整 FsService 契约的服务实例（类型只写 FsService：
 *   调用方拿到什么能力由契约说了算，不多不少）。
 */
export function createMemoryFs(): FsService {
  /** 文件路径 → 内容。目录是推导物，不入列。 */
  const files = new Map<string, string>()

  /** path 是否作为目录存在：根恒存在，其余当它是某个已存文件的祖先（或本身）时存在。 */
  const isDir = (path: string): boolean =>
    path === '/' || [...files.keys()].some((file) => file.startsWith(`${path}/`))

  /** path 是否在 base 目录的直接子级里；返回相对 base 的第一段。 */
  const firstSegment = (base: string, path: string): string | undefined => {
    const relative = base === '/' ? path.slice(1) : path.slice(base.length + 1)
    if (relative === '' || (base !== '/' && !path.startsWith(`${base}/`))) return undefined
    const [segment] = relative.split('/')
    return segment
  }

  return {
    async readFile(path) {
      const content = files.get(path)
      if (content !== undefined) return content
      if (isDir(path)) throw new FsError(`"${path}" 是目录，不是可读的普通文件（FS_NOT_A_FILE）`, 'FS_NOT_A_FILE')
      throw new FsError(`"${path}" 不存在（FS_NOT_FOUND）`, 'FS_NOT_FOUND')
    },

    async writeFile(path, content) {
      if (isDir(path) && !files.has(path)) {
        throw new FsError(`"${path}" 当前是目录，不能当文件写入（FS_NOT_A_FILE）`, 'FS_NOT_A_FILE')
      }
      // Map.set 整体替换：要么新值全在，要么旧值原封不动——「原子替换」在
      // 进程内 Map 上的最直接实现（真 provider 的对应物是临时文件 + rename）。
      files.set(path, content)
    },

    async listDir(path) {
      if (files.has(path)) {
        throw new FsError(`"${path}" 是文件，不是可列的目录（FS_NOT_A_DIRECTORY）`, 'FS_NOT_A_DIRECTORY')
      }
      if (!isDir(path)) throw new FsError(`"${path}" 不存在（FS_NOT_FOUND）`, 'FS_NOT_FOUND')
      const children = new Map<string, FsEntry>()
      for (const file of files.keys()) {
        const segment = firstSegment(path, file)
        if (segment === undefined) continue
        // 相对路径还有更深的一段，说明这个直接子项是目录；否则是文件。
        children.set(segment, {
          name: segment,
          type: file.slice(path === '/' ? 1 : path.length + 1).includes('/') ? 'directory' : 'file',
        })
      }
      // 按名字稳定排序：同一状态永远列出同一顺序（dsh 的 FsDirEntry 同款承诺）。
      return [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
  }
}
