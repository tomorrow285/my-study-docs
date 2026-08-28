// @ts-check
import { defineConfig } from 'astro/config';
import rehypeLinks from './src/plugins/rehype-links.mjs';

// https://astro.build/config
export default defineConfig({
  // 部署时替换为实际站点地址；留空相对路径也可本地预览
  site: 'https://docs.tongtong.tech',
  output: 'static',
  server: {
    // preview/dev 服务的主机名校验：放行本机与公网域名（nginx 反代会带上 docs Host 头）
    allowedHosts: ['localhost', '127.0.0.1', 'docs.tongtong.tech'],
  },
  markdown: {
    rehypePlugins: [rehypeLinks],
    shikiConfig: {
      // 浅色主题，中文注释可读性好
      theme: 'github-light',
      wrap: true,
    },
  },
});
