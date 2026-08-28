# 概念 · AGENTS.md 与 Skills（给 Agent 注入指令）

> **TL;DR**：Codex 会在会话开始时向上扫描目录树收集 **AGENTS.md**（人类给 Agent 的仓库说明），并通过 **Skills**（带 frontmatter 的可复用指令包）按需注入上下文。读完你能说出：AGENTS.md 和 Skill 各自什么时候进到模型视野、谁决定哪个 Skill 被加载。

**对应源码**：`codex-rs/core/src/agents_md.rs`、`codex-rs/skills/` crate、`codex-rs/core/src/skills.rs`

---

## AGENTS.md：给 Agent 的「仓库说明书」

### 是什么

`AGENTS.md` 是仓库作者给编码 Agent 写的说明文件（编码规范、项目结构、如何运行测试等）。Codex 遵循一个简单的**作用域规则**：文件对其所在目录树内的所有文件生效；嵌套的 AGENTS.md 覆盖外层的。

### 谁在什么时候加载

`load_project_instructions`（[agents_md.rs:57](C:\temp_project\codex\codex-rs\core\src\agents_md.rs#L57)）：

```rust
pub(crate) async fn load_project_instructions(
    config: &Config,
    user_instructions: Option<UserInstructions>,
    environments: &TurnEnvironmentSnapshot,
    windows_sandbox_level: WindowsSandboxLevel,
) -> io::Result<Option<LoadedAgentsMd>> {
    let mut loaded = LoadedAgentsMd::from_user_instructions(user_instructions);
    if config.active_project.is_untrusted() {
        return Ok((!loaded.is_empty()).then_some(loaded));   // ← 不信任的项目不加载文件，只留用户指令
    }
    let mut remaining = config.project_doc_max_bytes;        // ← 大小预算
    for turn_environment in environments.turn_environments() {
        if remaining == 0 { break; }
        // ... 在沙箱保护下读取 AGENTS.md（沙箱内读，防止越界）...
        match read_agents_md(config, filesystem.as_ref(), ..., remaining, sandbox.as_ref(), ...) { ... }
    }
}
```

**教学解读**：
- `LoadedAgentsMd` 记录加载到的 AGENTS.md 内容 + **来源追踪**（`sources()`），所以能回答「这句话从哪个 AGENTS.md 来的」——这正是调试 prompt 污染的关键信息。
- 两个细节值得注意：
  1. **不信任的项目不加载**：`active_project.is_untrusted()` 时，只保留用户指令，不读仓库里的 AGENTS.md——防止恶意仓库给 Agent 下毒。
  2. **大小预算**：`project_doc_max_bytes` 限制累计读取量，避免 AGENTS.md 太多撑爆上下文。
  3. **沙箱内读取**：用 `FileSystemSandboxContext` 限制读取范围。

### 什么时候进模型视野

AGENTS.md 内容进入 **WorldState** 的 `AgentsMdState` 段（见 [Context-and-Compaction](../Core-Modules/Context-and-Compaction.md)），在每个 step 构建世界状态时注入给模型。

---

## Skills：可复用的指令包

### 是什么

Skill 是一个带 frontmatter 的指令包（类似本技能文档），允许把「怎么做某类任务」沉淀下来按需复用。`skills` crate 负责加载、快照缓存和选择。

核心类型（[loading.rs:23-33](C:\temp_project\codex\codex-rs\skills\src\loading.rs#L23-L33)）：

```rust
pub struct LoadedSkillRoot { ... }     // 一个 skill 根目录（含技能文件+脚本）
pub struct LoadedSkills { ... }        // 一批已加载的 skills
```

| skills 子模块 | 职责 |
|--------------|------|
| `loading.rs` | 加载 + 快照缓存（`SkillRootSnapshotCache`） |
| `selection.rs` | **选择**：决定哪些 skill 加载 |
| `mentions.rs` | 从用户输入解析 skill 提及（`@skill`） |
| `parser.rs` | 解析 skill 的 frontmatter |
| `invocation.rs` | 技能调用 |

### 触发方式

Skill 的加载是**按需**的，而不是全量塞进上下文：

1. 用户/模型**显式提及**（mention）某个 skill → `mentions.rs` 解析 → 加载该 skill
2. 根据上下文**自动选择** → `selection.rs` 决策

> 💡 理解要点：**AGENTS.md 是「全量、常驻」的仓库说明，Skill 是「按需、可触发」的指令包**。前者默认就在，后者要有人「叫它」才进。

---

## 与周边的关系

- **`.codex/skills/`**：项目/用户级 skill 存放位置（仓库里 [.codex/skills/](C:\temp_project\codex\.codex\skills) 就有 babysit-pr 等例子）。
- **core 的 `skills.rs`**：处理 skill 的运行时注入；`mcp_skill_dependencies.rs`：skill 依赖的 MCP 服务器。
- **ext/skills 扩展**：`skills_extension::install`（cli/main.rs:2294）把 skills 打包进上下文指令。
- **hooks**：如果用户配置了 hooks，skill 相关事件也能触发 hooks（见 [Config-System](Config-System.md)）。

---

## 小结

- **AGENTS.md**：作用域=所在目录树，不信任项目不加载，有大小预算，进 `AgentsMdState`。
- **Skills**：按需加载的指令包，`mentions`（显式提及）或 `selection`（自动选择）触发。
- 两者都通过 WorldState 注入模型视野。

## 下一步阅读

- 世界状态怎么组装这些内容 → [Context-and-Compaction](../Core-Modules/Context-and-Compaction.md)
- 官方 Skills 文档 → [docs/skills.md](C:\temp_project\codex\docs\skills.md) 与 [AGENTS.md 规范](C:\temp_project\codex\docs\agents_md.md)
