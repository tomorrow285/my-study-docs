# my-study-docs 运维手册（AI Agent 专用）

给 AI Agent 的完整运维 runbook：从**拉取文档 → 构建 → 验证 → 上线**的全流程，以及所有踩过的坑。用户新增学习文档时按本手册操作即可。

## 服务架构

```
公网 https://docs.tongtong.tech
  └─ cloudflared 隧道 (systemd, 共享隧道 83eb4a97, config: /etc/cloudflared/config.yml)
       └─ ingress: docs.tongtong.tech → http://localhost:3082
            └─ nginx (sites-enabled/docs-static, 仅监听 127.0.0.1:3082)
                 └─ proxy_pass → http://127.0.0.1:4321
                      └─ astro preview (systemd 服务 my-study-docs)
                           └─ 静态读盘 dist/（构建产物）
```

- dsh.tongtong.tech 走同一条隧道 → nginx:3081 → dsh:3080，与本站无关，改配置时别碰
- **构建完不需要重启**：astro preview 每次请求直接读 `dist/` 磁盘文件，`pnpm build` 后新页面立即生效（保险起见可 `sudo systemctl restart my-study-docs`）

## 关键路径速查

| 项 | 路径 |
|---|---|
| 项目根 | `/home/tomorrow285/my-study-docs` |
| 内容源 | `docs/**/*.md`（一个项目一个子目录） |
| 构建产物 | `dist/`（gitignore，可随时重建） |
| systemd 单元 | `/etc/systemd/system/my-study-docs.service` |
| nginx 站点配置 | `/etc/nginx/sites-enabled/docs-static` |
| 站点配置 | `astro.config.mjs`（site + allowedHosts + rehype 插件） |
| 链接转换插件 | `src/plugins/rehype-links.mjs` |

## 文档站点约定（必须遵守）

- md 文件**无需 frontmatter**，第一个 `#` 标题 = 页面标题
- `docs/<项目>/Home.md` → `/项目/` 首页；**没有 Home.md 则 `/项目/` 404**（首页卡片仍会链接过去，坑）
- entry.id 与路由**全小写**（Astro 规范化）：`docs/ai-agent/Chapter1.md` → `/ai-agent/chapter1/`
- 文档互链用相对 `.md` 路径（`[x](chapter2.md)`），rehype-links 插件自动转路由；`http` 链接原样保留；Windows 绝对路径 `C:\temp_project\...` 自动转纯文本 `<code>`
- 图片放 `docs/<项目>/images/`，构建时 sharp 自动优化（PNG→webp）
- 子目录自动成为导航分组（如 `Core-Modules/`、`Concepts/`）
- **平铺文档自动分组**（无子目录的顶层文件按文件名前缀分组）：`chapter\d*` →「章节」、`intro*` → 概览、`afterword/epilogue/conclusion` →「后记」、`reference-answers/faq/appendix/references` →「附录」；分组内**自然排序**（chapter2 排在 chapter10 前）；Home 恒在概览最前。规则在 `src/lib/doc-utils.ts` 的 `FLAT_SECTION_RULES`，新增约定改这里
- 页面标题从 H1 提取，自动去掉行内 markdown 符号和 Pandoc 属性（`# 引言 {.unnumbered}` → 引言）

## 标准更新流程（用户新增/修改文档后）

```bash
# 1. 拉取最新代码（GitHub 需代理，两个 export 必须分设）
cd /home/tomorrow285/my-study-docs
export http_proxy=http://127.0.0.1:7897
export https_proxy=http://127.0.0.1:7897
git pull origin master

# 2. 依赖变化时才需要（package.json / pnpm-lock.yaml 有改动）
export PATH="/home/tomorrow285/.volta/bin:$PATH"   # volta Node 24
pnpm install

# 3. 构建（每次文档变更必跑）
export PATH="/home/tomorrow285/.volta/bin:$PATH"
pnpm build

# 4. 验证（三层：直连 → nginx → 公网）
curl --noproxy '*' -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4321/<path>      # astro 直连
curl --noproxy '*' -s -o /dev/null -w "%{http_code}\n" -H "Host: docs.tongtong.tech" http://127.0.0.1:3082/<path>  # 经 nginx
curl -s -o /dev/null -w "%{http_code}\n" --max-time 20 https://docs.tongtong.tech/<path>  # 公网
```

提交本仓库改动同样需挂代理 push。

## 坑与故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| 构建报 `MissingSharp: Could not find Sharp` | 文档里**引入了图片**，Astro 图片优化需要 sharp，pnpm 严格模式不自动装 | `pnpm add sharp`（allowBuilds 已放行） |
| 页面 403 `Blocked request. This host is not allowed` | astro preview/dev 的 allowedHosts 校验，nginx 反代带了外部 Host 头 | `astro.config.mjs` 的 `server.allowedHosts` 已放行 `docs.tongtong.tech`（改域名时才需动） |
| 构建失败，traceback 提到 `runDepsStatusCheck`/`verify-deps` | pnpm 11 默认拦截 build scripts（esbuild/sharp postinstall 没跑） | `pnpm-workspace.yaml` 已配 `allowBuilds: esbuild/sharp: true`；新加原生依赖时同步补 |
| 页面 404 | 访问了没有 Home.md 的项目根路径；或路径大小写不对（路由全小写） | 补 `docs/<项目>/Home.md`；用全小写路径 |
| 中文乱码 | — | 站点本身 UTF-8，无此问题（该坑属于行情脚本，不在此站） |
| 公网访问不了 | cloudflared / nginx / my-study-docs 任一服务挂了 | `systemctl is-active cloudflared nginx my-study-docs`，逐个排查 |
| git pull/push 卡死 | 代理未挂或单行 inline 代理语法丢了 https_proxy | 两个 export 分设后再跑 |

## systemd 服务（my-study-docs）

```ini
[Service]
User=tomorrow285
WorkingDirectory=/home/tomorrow285/my-study-docs
ExecStart=/home/tomorrow285/.hermes/home/.volta/tools/image/node/24.19.0/bin/node \
  /home/tomorrow285/my-study-docs/node_modules/astro/astro.js preview --host 127.0.0.1 --port 4321
Restart=on-failure
```

注意：systemd 必须用**绝对路径**的真实 node（`~/.hermes/home/.volta/...`），不能用 `~/.volta/bin` shim（systemd 环境下 $HOME 解析不同）。nginx 侧允许 www-data 读取 home 目录（`chmod o+x /home/tomorrow285` 已配）。
