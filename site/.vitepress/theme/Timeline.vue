<script setup lang="ts">
import lessons from '../../lessons-meta.json'

interface LessonMeta {
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

const stages: { id: number; name: string; note: string }[] = [
  { id: 1, name: '阶段一 · 最小循环', note: '纯手写，零框架' },
  { id: 2, name: '阶段二 · 可控与可恢复', note: '权限、恢复、压缩' },
  { id: 3, name: '阶段三 · 插件化（Cordis 之道）', note: '一切皆插件' },
  { id: 4, name: '阶段四 · 生产化能力', note: '沙箱、子代理、持久化' },
  { id: 5, name: '阶段五 · 组装与桥接', note: '通向你自己的业务' },
]

const byStage = (stage: number): LessonMeta[] =>
  (lessons as LessonMeta[]).filter((l) => l.stage === stage)

const maxLines = Math.max(...(lessons as LessonMeta[]).map((l) => l.lines), 1)
</script>

<template>
  <section v-for="stage in stages" :key="stage.id" class="stage">
    <h2 :id="`stage-${stage.id}`">
      {{ stage.name }}
      <span class="note">{{ stage.note }}</span>
    </h2>
    <div class="cards">
      <a v-for="lesson in byStage(stage.id)" :key="lesson.id" :href="lesson.href" class="card">
        <div class="card-head">
          <span class="id">{{ lesson.id }}</span>
          <span class="title">{{ lesson.title }}</span>
        </div>
        <p class="idea">{{ lesson.idea }}</p>
        <div class="badges">
          <span class="badge">{{ lesson.lines }} 行</span>
          <span class="badge">{{ lesson.tools }} 个工具</span>
        </div>
        <div class="dsh">
          <a
            v-for="d in lesson.dsh"
            :key="d.url"
            :href="d.url"
            class="chip"
            @click.stop
            rel="noopener"
          >dsh · {{ d.label }}</a>
        </div>
        <div class="bar" :style="{ width: `${Math.max((lesson.lines / maxLines) * 100, 4)}%` }" />
      </a>
    </div>
  </section>

  <section class="growth">
    <h2 id="growth">代码量增长</h2>
    <p class="note">课程示例随阶段长大；每根条是当课 src 的非空行数。</p>
    <div v-for="lesson in lessons" :key="lesson.id" class="growth-row">
      <span class="growth-id">{{ lesson.id }}</span>
      <div class="growth-track">
        <div class="growth-bar" :style="{ width: `${Math.max((lesson.lines / maxLines) * 100, 2)}%` }" />
      </div>
      <span class="growth-lines">{{ lesson.lines }} 行</span>
    </div>
  </section>
</template>

<style scoped>
.stage { margin-top: 2.5rem; }
.note { font-size: 0.85em; font-weight: normal; opacity: 0.6; margin-left: 0.5rem; }
.cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.card { display: block; border: 1px solid var(--vp-c-border); border-radius: 8px; padding: 1rem; text-decoration: none; color: inherit; transition: border-color 0.2s; }
.card:hover { border-color: var(--vp-c-brand); }
.card-head { display: flex; align-items: baseline; gap: 0.5rem; }
.id { font-family: monospace; color: var(--vp-c-brand); font-weight: 600; }
.idea { opacity: 0.85; margin: 0.5rem 0; }
.badges { display: flex; gap: 0.5rem; }
.badge { font-size: 0.8em; border: 1px solid var(--vp-c-border); border-radius: 999px; padding: 0.1rem 0.6rem; opacity: 0.85; }
.dsh { margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.4rem; }
.chip { font-size: 0.75em; font-family: monospace; color: var(--vp-c-text-code); background: var(--vp-code-bg); border-radius: 4px; padding: 0.1rem 0.4rem; text-decoration: none; }
.bar { margin-top: 0.75rem; height: 4px; border-radius: 2px; background: var(--vp-c-brand); opacity: 0.5; }
.growth { margin-top: 3rem; }
.growth-row { display: flex; align-items: center; gap: 0.75rem; margin: 0.4rem 0; }
.growth-id { font-family: monospace; min-width: 3rem; color: var(--vp-c-brand); }
.growth-track { flex: 1; background: var(--vp-c-default-soft); border-radius: 4px; }
.growth-bar { height: 14px; border-radius: 4px; background: var(--vp-c-brand); opacity: 0.75; }
.growth-lines { font-size: 0.85em; opacity: 0.7; min-width: 4.5rem; text-align: right; }
</style>
