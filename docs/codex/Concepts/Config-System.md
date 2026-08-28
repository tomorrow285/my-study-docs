# 概念 · 配置系统（分层加载 layer stack）

> **TL;DR**：Codex 的配置不是单个文件，而是**多层叠加**：`PackagedDefaults → Mdm → System → EnterpriseManaged → User → Project → SessionFlags`，后者覆盖前者。每层有自己的来源和优先级，最终合并成一个 `Config`。读完你能说出：为什么「项目里的 `.codex` 配置」会覆盖「用户主目录的配置」。

**对应源码**：`codex-rs/config/` crate（[config_layer_source.rs](C:\temp_project\codex\codex-rs\config\src\config_layer_source.rs)）、`codex-rs/core/src/config/mod.rs`（`Config`）

---

## 分层模型：来源与优先级

每一层配置的「来源」被定义成枚举 `ConfigLayerSource`（[config_layer_source.rs:6](C:\temp_project\codex\codex-rs\config\src\config_layer_source.rs#L6)），并且每层有一个 `precedence()` 数值（[config_layer_source.rs:33](C:\temp_project\codex\codex-rs\config\src\config_layer_source.rs#L33)）：

```rust
pub enum ConfigLayerSource {
    PackagedDefaults { file: AbsolutePathBuf },   // -10  安装自带的默认值
    Mdm { domain: String, key: String },          //   0  MDM 托管偏好
    System { file: AbsolutePathBuf },             //  10  系统级
    EnterpriseManaged { id, name },               //  15  企业云 bundle
    User { file, profile: Option<String> },       //  20/21 用户级（有 profile 更高）
    Project { dot_codex_folder: AbsolutePathBuf },//  25  项目级 .codex/
    SessionFlags,                                 //  30  本次会话命令行覆盖
    // ... 遗留的托管配置（40/50）
}
```

**覆盖规则**（源码注释，[config_layer_source.rs:31](C:\temp_project\codex\codex-rs\config\src\config_layer_source.rs#L31)）：

> "A setting from a layer with a higher precedence overrides a setting from a layer with a lower precedence."
> （优先级更高的层覆盖优先级更低的层。）

| 你的配置写在 | 优先级 | 谁会被它覆盖 |
|-------------|--------|-------------|
| `~/.codex/config.toml`（User） | 20 | PackagedDefaults / System / Mdm |
| 项目 `.codex/config.toml`（Project） | 25 | User 及以下 |
| 命令行 `-c key=value`（SessionFlags） | 30 | 一切文件配置 |

---

## 组装：从层到最终 Config

`core` 里的 `Config`（[core/src/config/mod.rs:601](C:\temp_project\codex\codex-rs\core\src\config\mod.rs#L601)）是最终合并结果，通过 `ConfigBuilder` 构建（`:1349`）：

```
ConfigBuilder::default()
    .cli_overrides(...)      // ← SessionFlags 层
    .build()                 // ← 加载各层并合并（cli/main.rs:2262 调用）
```

加载逻辑在 `config` crate 的 `loader/`（[loader/local.rs](C:\temp_project\codex\codex-rs\config\src\loader\local.rs)、[loader/project_discovery.rs](C:\temp_project\codex\codex-rs\config\src\loader\project_discovery.rs)）：发现 `config.toml` 位置 → 读各层 → 按 `ConfigLayerSource::precedence` 排序 → 逐层合并（`merge.rs`）。

> 📌 深入：`config.toml` 有 JSON Schema（`codex-rs/config/src/schema.rs`），编辑器可补全。也支持 `requirements.toml`（托管配置，企业强制），其中 `allow_managed_hooks_only = true` 可忽略用户/项目/会话的 hooks 配置，只保留托管 hooks（见 [docs/config.md](C:\temp_project\codex\docs\config.md)）。

---

## 哪些东西是"配置"

`Config` 里承载的主要类别（都带默认值，来自 `config/src/defaults.toml`）：

| 类别 | 例子 |
|------|------|
| 模型 | `model`、`model_provider` |
| 权限 | `permissions`（execpolicy 文件、文件系统沙箱策略） |
| 审批 | `approval_policy`、`approvals_reviewer` |
| 会话 | `cwd`、`sandbox_mode`、`history_mode` |
| 网络 | `network`（网络代理策略） |
| Hooks | 生命周期 hooks 配置 |
| 界面 | `tui_keymap`、主题 |

> 💡 学习时注意：**execpolicy 也是配置层的一部分**——`permissions` 里的 execpolicy 文件按同样的 layer stack 加载，所以不同项目可以有不同的命令策略。这衔接了 [Execution-Sandbox](../Core-Modules/Execution-Sandbox.md) 的「用户/项目可配置的 JSON」。

---

## 小结

- 配置是**九层蛋糕**，后层覆盖前层：`SessionFlags > Project > User > Enterprise > System > Mdm > Defaults`。
- `ConfigLayerSource::precedence()` 是合并排序的依据，注释就是「高层覆盖低层」。
- 一切权限、模型、审批都是配置；**execpolicy 跟着配置分层走**，是它与安全模型的结合点。

## 下一步阅读

- 安全策略怎么被配置驱动 → [Execution-Sandbox](../Core-Modules/Execution-Sandbox.md)
- 官方配置参考 → [developers.openai.com/codex/config-reference](https://developers.openai.com/codex/config-reference)（外部资料）
