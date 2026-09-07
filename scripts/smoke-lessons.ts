import { spawnSync } from 'node:child_process'
import { lessonPackageNames } from './course-contract'

const root = process.cwd()
const packages = lessonPackageNames(root)

for (const name of packages) {
  const started = performance.now()
  const run = spawnSync('pnpm', ['--filter', name, 'run', 'dev'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (run.error !== undefined || run.status !== 0) {
    process.stderr.write(run.stdout ?? '')
    process.stderr.write(run.stderr ?? '')
    throw run.error ?? new Error(`${name} smoke failed with exit code ${run.status}`)
  }
  console.log(`PASS ${name} (${Math.round(performance.now() - started)} ms)`)
}

console.log(`PASS lesson smoke: ${packages.length} runnable entries`)
