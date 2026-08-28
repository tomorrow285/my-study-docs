import type { CollectionEntry } from 'astro:content';

export interface NavItem {
  /** entry id，如 codex/Core-Modules/Agent-Turn-Loop */
  id: string;
  /** 从 H1 提取的标题 */
  title: string;
  /** 页面 URL，如 /codex/ 或 /codex/Core-Modules/Agent-Turn-Loop/ */
  href: string;
  /** 分组名：顶级文件为 ''，分组文件为 'Core-Modules' / 'Concepts' 等 */
  section: string;
  /** 导航树中的全局顺序 */
  order: number;
}

type DocEntry = CollectionEntry<'docs'>;

// 分组目录的固定展示顺序
const SECTION_ORDER = ['Core-Modules', 'Concepts'];
// 顶级文件的固定顺序
const TOP_FIRST = ['Home', 'Getting-Started'];

/** 从原始 markdown 正文提取 H1 作为标题（文档均无 frontmatter）。 */
export function extractTitle(body: string, fallback: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  const raw = m ? m[1] : fallback;
  // 去除行内 markdown 符号，保留中文
  return raw.replace(/[*_`]/g, '').trim();
}

/** entry id → 页面 URL：codex/home → /codex/；其余 → /codex/<子路径>/ */
export function idToHref(id: string): string {
  const parts = id.split('/');
  // Astro 把 rest 参数 slug 统一小写，entry.id 也是小写；home 结尾视为项目首页
  if (parts[parts.length - 1] === 'home') {
    return '/' + parts.slice(0, -1).join('/') + '/';
  }
  return '/' + parts.join('/') + '/';
}

/** 导航排序 key：返回 [分组顺序, 内部顺序]，按此排序即为导航树顺序 */
function navKey(restPath: string): [number, string] {
  const parts = restPath.split('/');
  if (parts.length === 1) {
    const name = parts[0];
    if (TOP_FIRST.includes(name)) return [0, String(TOP_FIRST.indexOf(name))];
    if (name === 'Interview-Questions') return [100, ''];
    return [10, name];
  }
  const secIdx = SECTION_ORDER.indexOf(parts[0]);
  const sec = secIdx === -1 ? 50 : secIdx;
  return [sec, parts.slice(1).join('/')];
}

/** 提取所有项目名（entry id 第一段，如 codex）。 */
export function getProjects(entries: DocEntry[]): string[] {
  return [...new Set(entries.map((e) => e.id.split('/')[0]))].sort();
}

/** 构建某个项目的导航树（含 title 与顺序）。 */
export function buildProjectNav(entries: DocEntry[], project: string): NavItem[] {
  const prefix = project + '/';
  const projectEntries = entries.filter((e) => e.id.startsWith(prefix));
  const items = projectEntries.map((e) => {
    const rest = e.id.slice(prefix.length);
    // entry id 全小写（Astro normalize）
    const isHome = rest === 'home';
    const section =
      rest === 'home' || rest === 'getting-started' || rest === 'interview-questions'
        ? ''
        : rest.split('/')[0];
    return {
      id: e.id,
      title: extractTitle(e.body ?? '', rest),
      href: idToHref(e.id),
      section,
      order: navKey(rest)[0],
    } as NavItem;
  });
  items.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    // 同组按字母序；顶级文件按固定顺序
    const restA = a.id.slice(prefix.length);
    const restB = b.id.slice(prefix.length);
    return restA.localeCompare(restB, 'zh-CN');
  });
  return items;
}

/** 从导航树取上一项 / 下一项。 */
export function prevNext(nav: NavItem[], currentId: string): { prev?: NavItem; next?: NavItem } {
  const idx = nav.findIndex((n) => n.id === currentId);
  if (idx === -1) return {};
  return {
    prev: idx > 0 ? nav[idx - 1] : undefined,
    next: idx < nav.length - 1 ? nav[idx + 1] : undefined,
  };
}
