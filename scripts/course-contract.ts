import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse } from 'yaml'

const REQUIRED_HEADINGS = ['## 为什么', '## 跑起来', '## 看真码', '## 术语']
const LESSON_DIR = /^(s\d{2})-([a-z0-9-]+)$/
const DSH_URL = /^https:\/\/github\.com\/deepseek-ai\/deepseek-harness\/(?:blob|tree)\//

export interface CourseContractResult {
  lessonIds: string[]
  errors: string[]
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/**
 * Validate the public contract shared by every lesson: metadata, runnable entry,
 * test presence, document shape, ordering, and sidebar reachability.
 */
export function validateCourse(root = process.cwd()): CourseContractResult {
  const lessonsRoot = join(root, 'lessons')
  const configPath = join(root, 'site', '.vitepress', 'config.ts')
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  const errors: string[] = []
  const records: Array<{ id: string; stage: number; dir: string }> = []

  for (const dir of readdirSync(lessonsRoot).sort()) {
    const match = LESSON_DIR.exec(dir)
    if (match === null) continue
    const [, expectedId, expectedSlug] = match
    const lessonDir = join(lessonsRoot, dir)
    const required = ['lesson.yaml', 'README.md', 'package.json', 'src/index.ts']
    for (const relative of required) {
      if (!existsSync(join(lessonDir, relative))) errors.push(`${dir}: missing ${relative}`)
    }
    if (required.some((relative) => !existsSync(join(lessonDir, relative)))) continue

    let meta: Record<string, unknown>
    let pkg: { name?: string; scripts?: Record<string, string> }
    try {
      meta = parse(readFileSync(join(lessonDir, 'lesson.yaml'), 'utf8')) as Record<string, unknown>
    } catch (error) {
      errors.push(`${dir}: invalid lesson.yaml: ${String(error)}`)
      continue
    }
    try {
      pkg = JSON.parse(readFileSync(join(lessonDir, 'package.json'), 'utf8')) as typeof pkg
    } catch (error) {
      errors.push(`${dir}: invalid package.json: ${String(error)}`)
      continue
    }

    const id = String(meta.id ?? '')
    const slug = String(meta.slug ?? '')
    const stage = Number(meta.stage)
    records.push({ id, stage, dir })
    if (id !== expectedId) errors.push(`${dir}: id must be ${expectedId}, got ${id || '<empty>'}`)
    if (slug !== expectedSlug) errors.push(`${dir}: slug must be ${expectedSlug}, got ${slug || '<empty>'}`)
    if (!Number.isInteger(stage) || stage < 1) errors.push(`${dir}: stage must be a positive integer`)
    for (const field of ['title', 'idea', 'verifiedDshVersion']) {
      if (typeof meta[field] !== 'string' || meta[field].trim() === '') errors.push(`${dir}: missing ${field}`)
    }
    if (!/^0\.1\.0-rc\.\d+$/.test(String(meta.verifiedDshVersion ?? ''))) {
      errors.push(`${dir}: verifiedDshVersion must look like 0.1.0-rc.N`)
    }
    const links = Array.isArray(meta.dsh) ? meta.dsh : []
    if (links.length === 0) errors.push(`${dir}: dsh must contain at least one source link`)
    for (const [index, link] of links.entries()) {
      const item = link as { label?: unknown; url?: unknown }
      if (typeof item.label !== 'string' || item.label.trim() === '') errors.push(`${dir}: dsh[${index}] missing label`)
      if (typeof item.url !== 'string' || !DSH_URL.test(item.url)) errors.push(`${dir}: dsh[${index}] is not a dsh source URL`)
    }

    const readme = readFileSync(join(lessonDir, 'README.md'), 'utf8')
    if (!readme.startsWith(`# ${id} · `)) errors.push(`${dir}: README title must start with "# ${id} · "`)
    for (const heading of REQUIRED_HEADINGS) {
      if (!readme.includes(heading)) errors.push(`${dir}: README missing section prefix "${heading}"`)
    }
    if (pkg.name !== `@learn-dsh/${dir}`) errors.push(`${dir}: package name must be @learn-dsh/${dir}`)
    if (pkg.scripts?.dev !== 'tsx src/index.ts') errors.push(`${dir}: dev script must be "tsx src/index.ts"`)
    const testCount = readdirSync(join(lessonDir, 'src')).filter((file) => file.endsWith('.test.ts')).length
    if (testCount === 0) errors.push(`${dir}: src must contain at least one *.test.ts`)

    const href = `/lessons/${dir}/`
    if (countOccurrences(config, `link: '${href}'`) !== 1) errors.push(`${dir}: sidebar must contain ${href} exactly once`)
  }

  const ids = records.map((record) => record.id)
  if (new Set(ids).size !== ids.length) errors.push('course: lesson ids must be unique')
  records.forEach((record, index) => {
    const expected = `s${String(index + 1).padStart(2, '0')}`
    if (record.id !== expected) errors.push(`course: expected ${expected} at position ${index + 1}, got ${record.id}`)
    if (index > 0 && record.stage < records[index - 1]!.stage) {
      errors.push(`course: stage decreases from ${records[index - 1]!.dir} to ${record.dir}`)
    }
  })

  return { lessonIds: ids, errors }
}

export function assertCourseContract(root = process.cwd()): string[] {
  const result = validateCourse(root)
  if (result.errors.length > 0) throw new Error(`Course contract failed:\n- ${result.errors.join('\n- ')}`)
  return result.lessonIds
}

export function lessonPackageNames(root = process.cwd()): string[] {
  return readdirSync(join(root, 'lessons'))
    .filter((dir) => LESSON_DIR.test(dir))
    .sort()
    .map((dir) => {
      const pkg = JSON.parse(readFileSync(join(root, 'lessons', dir, 'package.json'), 'utf8')) as { name: string }
      if (!pkg.name) throw new Error(`${basename(dir)}: package.json missing name`)
      return pkg.name
    })
}
