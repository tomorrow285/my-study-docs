// rehype 插件：统一处理文档里的两类链接
//  1. `.md` 相对链接（文档互链）→ 转换为 Astro 路由 URL，保留 #锚点
//  2. Windows 绝对路径源码引用（C:\temp_project\codex\...）→ 转为纯文本 <code>
//
// 原理：Astro 渲染 markdown 时传入的 file 携带源文件绝对路径（file.path / file.url），
// 据此把相对 .md 链接解析成项目根内路径，再映射为 /<project>/<子路径>/ 路由。
import { dirname, resolve, relative, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { visit } from 'unist-util-visit';

// Windows 源码引用前缀（文档中的仓库路径），显示时去掉，只保留仓库内相对路径
const SRC_PREFIX = /^[A-Za-z]:[\\/]temp_project[\\/]codex[\\/]/i;

// 从任意路径向上查找 Astro 项目根（含 package.json 的最近祖先），避免依赖 process.cwd()
function findProjectRoot(fromPath) {
  let dir = dirname(fromPath);
  while (dir && dir !== dirname(dir)) {
    if (existsSync(normalize(resolve(dir, 'package.json')))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

// C:\temp_project\codex\codex-rs\core\src\xxx.rs#L123 → codex-rs/core/src/xxx.rs:123
// C:\...\xxx.rs#L341-L354                          → codex-rs/core/src/xxx.rs:341-354
function pathText(href) {
  // Astro 会把 href 里的反斜杠 URL 编码为 %5C（甚至 %255C），循环解码到稳定
  let p = href;
  for (let i = 0; i < 3; i++) {
    let decoded;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      break;
    }
    if (decoded === p) break;
    p = decoded;
  }
  p = p.replace(SRC_PREFIX, '').replace(/\\/g, '/');
  p = p.replace(/#L(\d+)(?:-L(\d+))?/, (_, a, b) => (b ? `:${a}-${b}` : `:${a}`));
  return p;
}

// 判断是否为 Windows 绝对路径链接（兼容原始反斜杠与 URL 编码 %5C 两种形式）
function isWindowsPath(href) {
  return /^[A-Za-z]:[\\/]/.test(href) || /^[A-Za-z]:%5[Cc]/.test(href);
}

export default function rehypeLinks() {
  return (tree, file) => {
    // 源 md 文件绝对路径
    const sourcePath = file.path || fileURLToPath(file.url);
    const baseDir = dirname(sourcePath);
    const projectRoot = findProjectRoot(sourcePath);

    visit(tree, (node, index, parent) => {
      if (node.type !== 'element' || node.tagName !== 'a') return;
      const href = node.properties?.href;
      if (typeof href !== 'string' || href === '') return;

      // 1) Windows 绝对路径源码引用 → <code> 纯文本
      if (isWindowsPath(href)) {
        const replacement = {
          type: 'element',
          tagName: 'code',
          properties: { className: ['src-path'] },
          children: [{ type: 'text', value: pathText(href) }],
        };
        if (parent && index !== null && index !== undefined) {
          parent.children[index] = replacement;
        }
        return 'skip';
      }

      // 2) .md 相对链接 → 路由 URL（保留 #锚点）；http 链接跳过
      const m = href.match(/^([^#]*\.md(?:x)?)(#[^]*)?$/i);
      if (!m) return;
      const target = resolve(baseDir, m[1]);
      let rel = normalize(relative(projectRoot, target))
        .replace(/\\/g, '/')
        .replace(/\.mdx?$/i, '')
        .toLowerCase(); // Astro 将 rest 参数 slug 统一小写，URL 必须小写匹配
      // 去掉 docs/ 前缀 → codex/Core-Modules/Agent-Turn-Loop
      rel = rel.replace(/^docs\//, '');
      // home 结尾 → 项目首页；否则 → 文档页
      const url = rel.endsWith('/home')
        ? '/' + rel.slice(0, -'/home'.length) + '/'
        : '/' + rel + '/';
      node.properties.href = url + (m[2] ?? '');
    });
  };
}
