import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

/** 统计 files 里非 *.test.ts 文件的非空行数。行数是教学叙事指标，不做注释剔除。 */
export async function countLines(files: string[]): Promise<number> {
  const { stat } = await import('node:fs/promises')
  let lines = 0
  for (const file of files) {
    if (file.endsWith('.test.ts') || !(await stat(file)).isFile()) continue
    lines += readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '').length
  }
  return lines
}

/** 数 files 里 = defineTool( 出现次数（只数调用赋值，排除函数声明行——课程定义工具的统一约定）。 */
export function countTools(files: string[]): number {
  return files.reduce(
    (n, file) => n + (readFileSync(file, 'utf8').match(/= defineTool\(/g)?.length ?? 0),
    0,
  )
}

export interface LessonMeta {
  id: string
  stage: number
  title: string
  idea: string
  lines: number
  tools: number
  dsh: { label: string; url: string }[]
  verifiedDshVersion: string
  href: string
}

/**
 * 全仓同步：统计每课行数/工具数写回 lesson.yaml（yaml Document API 保留注释），
 * 再把 README 投影为站点页面并汇总 lessons-meta.json。幂等，可反复运行。
 */
export async function syncLessons(root = process.cwd()): Promise<void> {
  const lessonsRoot = join(root, 'lessons')
  const meta: LessonMeta[] = []

  for (const dir of readdirSync(lessonsRoot).sort()) {
    const lessonDir = join(lessonsRoot, dir)
    const yamlPath = join(lessonDir, 'lesson.yaml')
    const srcDir = join(lessonDir, 'src')
    let srcFiles: string[] = []
    try {
      srcFiles = readdirSync(srcDir).map((f) => join(srcDir, f))
    } catch {
      // 没有 src 的目录（如 shared/）不是课程，跳过统计但也不投影。
      continue
    }
    try {
      readFileSync(yamlPath)
    } catch {
      continue
    }

    const doc = parseDocument(readFileSync(yamlPath, 'utf8'))
    const lines = await countLines(srcFiles)
    const tools = countTools(srcFiles)
    doc.set('lines', lines)
    doc.set('tools', tools)
    writeFileSync(yamlPath, String(doc))

    const readme = readFileSync(join(lessonDir, 'README.md'), 'utf8')
    const pageDir = join(root, 'site', 'lessons', dir)
    mkdirSync(pageDir, { recursive: true })
    writeFileSync(
      join(pageDir, 'index.md'),
      `---\ntitle: ${doc.get('title')}\ndescription: ${doc.get('idea')}\n---\n\n${readme}`,
    )

    meta.push({
      id: String(doc.get('id')),
      stage: Number(doc.get('stage')),
      title: String(doc.get('title')),
      idea: String(doc.get('idea')),
      lines,
      tools,
      dsh: (doc.get('dsh') as { label: string; url: string }[]) ?? [],
      verifiedDshVersion: String(doc.get('verifiedDshVersion')),
      href: `/lessons/${dir}/`,
    })
  }

  meta.sort((a, b) => a.id.localeCompare(b.id))
  mkdirSync(join(root, 'site'), { recursive: true })
  writeFileSync(join(root, 'site', 'lessons-meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
}

// 直接运行时（pnpm run sync）执行；被测试导入时不执行。
if (process.argv[1]?.endsWith('sync-lessons.ts')) {
  await syncLessons()
}
