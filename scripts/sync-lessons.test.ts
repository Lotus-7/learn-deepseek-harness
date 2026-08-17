import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { countLines, countTools, syncLessons } from './sync-lessons'

const root = mkdtempSync(join(tmpdir(), 'sync-lessons-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('countLines / countTools', () => {
  it('统计非空行，忽略测试文件', async () => {
    const dir = join(root, 'fixture')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1\n\nconst b = 2\n')
    writeFileSync(join(dir, 'src', 'a.test.ts'), 'const x = 1\nconst y = 2\n')
    expect(await countLines([join(dir, 'src', 'a.ts'), join(dir, 'src', 'a.test.ts')])).toBe(2)
  })

  it('数 defineTool 的调用次数，排除函数声明行', () => {
    const dir = join(root, 'fixture2')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'tools.ts')
    writeFileSync(file, 'export function defineTool(t) { return t }\nconst a = defineTool({})\nconst b = defineTool({})\n')
    expect(countTools([file])).toBe(2)
  })
})

describe('syncLessons', () => {
  it('写回统计值并产出站点投影', async () => {
    const lessonDir = join(root, 'lessons', 's01-min-loop')
    mkdirSync(join(lessonDir, 'src'), { recursive: true })
    writeFileSync(
      join(lessonDir, 'lesson.yaml'),
      [
        'id: s01',
        'stage: 1',
        'slug: min-loop',
        'title: 最小循环',
        'idea: 调模型、跑工具、喂结果',
        'lines: 0',
        'tools: 0',
        'dsh:',
        '  - label: packages/core/agent-loop',
        '    url: https://example.com/agent-loop',
        'verifiedDshVersion: 0.1.0-rc.5',
        '',
      ].join('\n'),
    )
    writeFileSync(join(lessonDir, 'README.md'), '# 最小循环\n\n正文。\n')
    writeFileSync(join(lessonDir, 'src', 'main.ts'), 'const t = defineTool({})\n\nconst x = 1\n')

    await syncLessons(root)

    const yamlOut = readFileSync(join(lessonDir, 'lesson.yaml'), 'utf8')
    expect(yamlOut).toContain('lines: 2')
    expect(yamlOut).toContain('tools: 1')

    const page = readFileSync(join(root, 'site', 'lessons', 's01-min-loop', 'index.md'), 'utf8')
    expect(page).toContain('title: 最小循环')
    expect(page).toContain('description: 调模型、跑工具、喂结果')
    expect(page).toContain('# 最小循环')

    const meta = JSON.parse(readFileSync(join(root, 'site', 'lessons-meta.json'), 'utf8')) as Array<{
      id: string
      href: string
    }>
    expect(meta).toEqual([
      expect.objectContaining({ id: 's01', href: '/lessons/s01-min-loop/', lines: 2, tools: 1 }),
    ])
  })
})
