import DefaultTheme from 'vitepress/theme'
import Timeline from './Timeline.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Timeline', Timeline)
  },
}
