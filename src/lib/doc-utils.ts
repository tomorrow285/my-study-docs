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

// 平铺文档（无子目录）的分组约定：顶层文件名按前缀归入语义分组，
// 让扁平项目（如 ai-agent 的章节式文档）也有类似 codex 的分组侧边栏。
// entry.id 已全小写，正则用小写匹配。'' 表示归入「概览」组。
const FLAT_SECTION_RULES: [RegExp, string][] = [
  [/^intro/, ''], // 引言 → 概览
  [/^chapter\d/, '章节'],
  [/^afterword|^epilogue|^conclusion/, '后记'],
  [/^reference-answers|^faq|^appendix|^references/, '附录'],
];
// 平铺分组的展示顺序（越小越靠前）
const FLAT_SECTION_ORDER: Record<string, number> = { '': 0, 章节: 1, 后记: 2, 附录: 3 };

// 文件名自然排序（chapter2 < chapter10），zh 排序兼容中文
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN', { numeric: true });
}

/** 从原始 markdown 正文提取 H1 作为标题（文档均无 frontmatter）。 */
export function extractTitle(body: string, fallback: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  const raw = m ? m[1] : fallback;
  // 去除行内 markdown 符号与 Pandoc 属性（{#id .class}），保留中文
  return raw.replace(/\s*\{[^}]*\}$/, '').replace(/[*_`]/g, '').trim();
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
    // entry.id 全小写（'home' 匹配 'Home'）
    if (TOP_FIRST.some((t) => t.toLowerCase() === name)) {
      return [0, String(TOP_FIRST.findIndex((t) => t.toLowerCase() === name))];
    }
    if (name === 'interview-questions') return [100, ''];
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
    const isFlatTop = !rest.includes('/');
    let section =
      rest === 'home' || rest === 'getting-started' || rest === 'interview-questions'
        ? ''
        : rest.split('/')[0];
    let flatMatched = false;
    // 顶层平铺文件：按文件名前缀归入语义分组（codex 的 Getting-Started / Interview-Questions 不在此列）
    if (isFlatTop && !isHome && rest !== 'getting-started' && rest !== 'interview-questions') {
      const flat = FLAT_SECTION_RULES.find(([re]) => re.test(rest));
      if (flat) {
        section = flat[1];
        flatMatched = true;
      }
    }
    let order = navKey(rest)[0];
    // 仅命中平铺规则的文件才用分组顺序覆盖默认排序
    if (flatMatched) order = FLAT_SECTION_ORDER[section] ?? order;
    return {
      id: e.id,
      title: extractTitle(e.body ?? '', rest),
      href: idToHref(e.id),
      section,
      order,
    } as NavItem;
  });
  items.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    // 同组按自然顺序（chapter2 排在 chapter10 前）；顶级文件按固定顺序
    const restA = a.id.slice(prefix.length);
    const restB = b.id.slice(prefix.length);
    return naturalCompare(restA, restB);
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
