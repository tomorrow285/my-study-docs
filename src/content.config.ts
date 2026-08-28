import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

// 从项目根 docs/ 目录加载所有 markdown 学习文档（无需 frontmatter）。
// entry.id 形如 `codex/Core-Modules/Agent-Turn-Loop`（相对 ./docs 的路径去 .md）。
// 不写 schema：文档均无 YAML frontmatter，以 data:{} 正常加载。
const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './docs' }),
});

export const collections = { docs };
