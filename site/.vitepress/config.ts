import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Learn DeepSeek Harness',
  description:
    '从最小循环到生产级 agent harness：概念演进 + 可运行示例 + deepseek-harness 源码导读',
  // GitHub Pages 项目页挂在子路径下；缺 base 会生成根绝对资产/链接 URL，线上全部 404。
  base: '/learn-deepseek-harness/',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '时间线', link: '/timeline' },
      { text: '术语表', link: '/glossary' },
      { text: '关于', link: '/about' },
      {
        text: 'GitHub',
        link: 'https://github.com/Lotus-7/learn-deepseek-harness',
      },
      {
        text: 'deepseek-harness',
        link: 'https://github.com/deepseek-ai/deepseek-harness',
      },
    ],
    // 新增课程时在 items 里加一行；sync 脚本不改这里，保持显式。
    sidebar: {
      '/lessons/': {
        text: '课程',
        items: [{ text: 's01 最小循环', link: '/lessons/s01-min-loop/' }],
      },
    },
    outline: { level: [2, 3] },
  },
})
