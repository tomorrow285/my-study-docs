// @ts-check
import { defineConfig } from 'astro/config';
import rehypeLinks from './src/plugins/rehype-links.mjs';

// https://astro.build/config
export default defineConfig({
  // 部署时替换为实际站点地址；留空相对路径也可本地预览
  site: 'https://example.com',
  output: 'static',
  markdown: {
    rehypePlugins: [rehypeLinks],
    shikiConfig: {
      // 浅色主题，中文注释可读性好
      theme: 'github-light',
      wrap: true,
    },
  },
});
