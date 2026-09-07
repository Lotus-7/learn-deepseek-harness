import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateCourse } from './course-contract'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureFromRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'course-contract-'))
  roots.push(root)
  mkdirSync(join(root, 'lessons'), { recursive: true })
  mkdirSync(join(root, 'site', '.vitepress'), { recursive: true })
  cpSync(join(process.cwd(), 'lessons', 's01-min-loop'), join(root, 'lessons', 's01-min-loop'), { recursive: true })
  writeFileSync(
    join(root, 'site', '.vitepress', 'config.ts'),
    "const sidebar = [{ link: '/lessons/s01-min-loop/' }]\n",
  )
  return root
}

describe('course contract', () => {
  it('accepts a complete lesson contract', () => {
    const root = fixtureFromRepository()
    expect(validateCourse(root)).toEqual({ lessonIds: ['s01'], errors: [] })
  })

  it('reports a broken public entry and missing sidebar route', () => {
    const root = fixtureFromRepository()
    const packagePath = join(root, 'lessons', 's01-min-loop', 'package.json')
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts: { dev: string } }
    pkg.scripts.dev = 'tsx src/missing.ts'
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
    writeFileSync(join(root, 'site', '.vitepress', 'config.ts'), 'export default {}\n')

    const errors = validateCourse(root).errors
    expect(errors).toContain('s01-min-loop: dev script must be "tsx src/index.ts"')
    expect(errors).toContain('s01-min-loop: sidebar must contain /lessons/s01-min-loop/ exactly once')
  })
})
