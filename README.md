# my-study-docs（学习文档库）

基于 **Astro 5** 的静态学习文档站。从 `docs/` 目录下的 Markdown 文件自动生成站点页面，已部署在 **https://docs.tongtong.tech/**。

适合把零散的学习笔记（源码解读、教程翻译等）整理成带左侧导航、前后翻页的在线阅读站。

## 项目结构

```
my-study-docs/
├── docs/                  # 内容源：所有学习文档（Markdown）
│   ├── codex/             # 一个项目 = 一个目录
│   │   ├── Home.md        # 项目首页（可选，存在则 /codex/ 可访问）
│   │   └── Core-Modules/  # 支持子目录分组
│   └── ai-agent/
├── src/
│   ├── content.config.ts  # 内容集合：加载 docs/**/*.md（无需 frontmatter）
│   ├── pages/[...slug].astro  # 路由：/项目/子路径/ → 对应 md 页面
│   ├── plugins/rehype-links.mjs # 把 .md 相对链接转成站点路由
│   └── layouts/DocLayout.astro
├── astro.config.mjs       # site、allowedHosts、markdown 配置
└── package.json           # astro + unist-util-visit + sharp
```

## 如何新增学习文档

1. 在 `docs/` 下新建目录：`docs/<项目名>/`
2. 放入 Markdown 文件（**无需 YAML frontmatter**），文件第一个 `#` 标题就是页面标题：
   - `docs/<项目名>/Home.md` → 项目首页 `/项目名/`（可选，但没有它 `/项目名/` 会 404）
   - `docs/<项目名>/xxx.md` → 页面 `/项目名/xxx/`
   - 支持子目录分组：`docs/<项目名>/Core-Modules/xxx.md` → `/项目名/core-modules/xxx/`（路由全小写）
3. 文档间互链用相对路径：`[下一章](chapter2.md)`，构建时自动转为站点路由
4. 图片放在 `docs/<项目名>/images/`，构建时自动压缩优化（PNG → webp）
5. 平铺的章节式文档（如 ai-agent）会自动分组：`chapter1.md`~`chapter10.md` 归入「章节」并按数字排序、`introduction.md` 进「概览」、`afterword.md` 归「后记」、`reference-answers.md` 归「附录」——无需建子目录也能有合理的侧边栏

## 本地开发

```bash
# 安装依赖（Node ≥22，本机用 Volta 管理的 Node 24）
pnpm install

# 本地预览（http://localhost:4321，改文件热更新）
pnpm dev

# 构建静态站（产物在 dist/）
pnpm build

# 预览构建产物
pnpm preview
```

## 部署与更新（docs.tongtong.tech）

服务链路：**Cloudflare 隧道**（公网 HTTPS）→ **nginx**（127.0.0.1:3082 反代）→ **Astro preview**（127.0.0.1:4321，systemd 服务 `my-study-docs`）。

新增/修改文档后：

```bash
git pull origin master            # 拉取最新代码
pnpm install                      # 依赖有变化才需要
pnpm build                        # 重新构建，立即生效（无需重启服务）
```

构建完预览服务会直接读取新的 `dist/`，无需重启；保险起见可 `sudo systemctl restart my-study-docs`。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm build` | 构建静态站（更新文档后必跑） |
| `pnpm dev` | 本地开发预览 |
| `sudo systemctl status my-study-docs` | 查看线上服务状态 |
| `sudo systemctl restart my-study-docs` | 重启线上服务（一般不需要） |
| `sudo nginx -t && sudo systemctl reload nginx` | 改了 nginx 配置后重载 |

> 详细的运维手册（架构、坑、故障排查）见 [AGENTS.md](./AGENTS.md)。
