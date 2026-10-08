import { defineConfig } from 'vitepress'

// MiniSearch 默认按空白切词，中文整句会粘成一个 token，短词基本搜不到；
// 用 Intl.Segmenter 分词（Node 22 与现代浏览器均内置），中英文按 isWordLike 统一处理。
const zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const tokenize = (text: string): string[] => {
  const tokens: string[] = []
  for (const segment of zhSegmenter.segment(text)) {
    if (segment.isWordLike) tokens.push(segment.segment.toLowerCase())
  }
  return tokens
}

export default defineConfig({
  lang: 'zh-CN',
  title: 'Learn DeepSeek Harness',
  description:
    '从最小循环到生产级 agent harness：概念演进 + 可运行示例 + deepseek-harness 源码导读',
  // GitHub Pages 项目页挂在子路径下；缺 base 会生成根绝对资产/链接 URL，线上全部 404。
  base: '/learn-deepseek-harness/',
  cleanUrls: true,
  // hostname 需带项目子路径：VitePress sitemap 生成 loc 时不拼 base，缺了会指到 404。
  sitemap: { hostname: 'https://lotus-7.github.io/learn-deepseek-harness/' },
  themeConfig: {
    search: {
      provider: 'local',
      options: {
        miniSearch: { options: { tokenize } },
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '没有找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },
    docFooter: { prev: '上一页', next: '下一页' },
    outlineTitle: '本页目录',
    returnToTopLabel: '回到顶部',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色',
    darkModeSwitchTitle: '切换到深色',
    sidebarMenuLabel: '菜单',
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
        items: [
          { text: 's01 最小循环', link: '/lessons/s01-min-loop/' },
          { text: 's02 工具与管线', link: '/lessons/s02-tools/' },
          { text: 's03 会话日志', link: '/lessons/s03-session-log/' },
          { text: 's04 权限与审批', link: '/lessons/s04-permission/' },
          { text: 's05 取消与恢复', link: '/lessons/s05-recovery/' },
          { text: 's06 上下文压缩', link: '/lessons/s06-compaction/' },
          { text: 's07 迷你 Cordis', link: '/lessons/s07-cordis/' },
          { text: 's08 五件套插件化', link: '/lessons/s08-plugins/' },
          { text: 's09 能力接缝', link: '/lessons/s09-seam/' },
          { text: 's10 沙箱执行世界', link: '/lessons/s10-sandbox/' },
          { text: 's11 子代理', link: '/lessons/s11-subagent/' },
          { text: 's12 技能与工作流', link: '/lessons/s12-skills/' },
          { text: 's13 持久化', link: '/lessons/s13-persistence/' },
          { text: 's14 profile 组装', link: '/lessons/s14-bundles/' },
          { text: 's15 桥接真包', link: '/lessons/s15-bridge/' },
          { text: 's16 全景回顾', link: '/lessons/s16-recap/' },
        ],
      },
    },
    outline: { level: [2, 3] },
  },
})
