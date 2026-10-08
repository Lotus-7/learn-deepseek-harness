import { assertCourseContract } from './course-contract'

const ids = assertCourseContract()
console.log(`PASS course contract: ${ids.length} lessons (${ids[0]}–${ids.at(-1)})`)
