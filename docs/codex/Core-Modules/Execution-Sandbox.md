# 核心模块 · 执行与安全沙箱（安全设计精髓）

> **TL;DR**：Codex 用**三层防线**约束 Agent 执行命令：① **execpolicy**（JSON 策略判定 Allow/Prompt/Forbidden）→ ② **审批**（Hooks → Guardian → 用户）→ ③ **沙箱**（进程隔离）。读完你能说出一条命令从「模型想跑」到「真正跑起来」经过的每道关卡。

**对应源码**：`codex-rs/core/src/` 下的 [exec_policy.rs](C:\temp_project\codex\codex-rs\core\src\exec_policy.rs)、[exec.rs](C:\temp_project\codex\codex-rs\core\src\exec.rs)；`codex-rs/execpolicy/`（策略引擎）；`codex-rs/sandboxing/`（沙箱抽象）

> 前置知识：读完 [Tools-System](Tools-System.md)，知道 `ToolOrchestrator::run` 是「审批+沙箱+重试」的集中点。本文讲这三道防线的**底层机制**。

---

## 0. 一条命令的三层防线

当模型想执行 `rm -rf /`（举极端例子），它要连过三关：

```
模型请求: shell("rm -rf /")
   │
   ▼ 第 1 关  execpolicy（策略判定）
   │   core/src/exec_policy.rs:311  create_exec_approval_requirement_for_command
   │   execpolicy 引擎对命令做前缀匹配 + 真实可执行文件路径匹配
   │   ──► Decision: Allow / Prompt / Forbidden
   │
   ▼ 第 2 关  审批（approval）
   │   tools/orchestrator.rs:125  ToolOrchestrator::run
   │   Forbidden → 直接拒绝；NeedsApproval → request_approval
   │   审批者优先级: Hooks → Guardian(自动) → 用户
   │
   ▼ 第 3 关  沙箱（进程隔离）
   │   sandboxing/manager.rs: 选择 SandboxType
   │   sandboxing/spawn.rs:42  spawn_process 以受限方式起进程
   │   macOS: Seatbelt │ Linux: bubblewrap/Landlock │ Windows: 受限令牌
   │
   ▼ 执行  （沙箱内运行，越界被拦）
```

> 设计权衡一句话：**沙箱越强，需要的人工审批越少**。三层是「策略→人机审→隔离」的纵深防御，谁都不是绝对可信。

---

## 第 1 关：execpolicy —— 策略判定

### 三态决策

`execpolicy` crate 定义核心枚举 `Decision`（[decision.rs:7-27](C:\temp_project\codex\codex-rs\execpolicy\src\decision.rs#L7-L27)）：

```rust
pub enum Decision {
    /// Command may run without further approval.
    Allow,
    /// Request explicit user approval; rejected outright when running with `approval_policy="never"`.
    Prompt,
    /// Command is blocked without further consideration.
    Forbidden,
}
```

| 决策 | 含义 | 后果 |
|------|------|------|
| `Allow` | 允许，无需审批 | `ExecApprovalRequirement::Skip` |
| `Prompt` | 要人审 | `NeedsApproval`（`approval_policy="never"` 时升级为拒绝） |
| `Forbidden` | 直接禁止 | `ExecApprovalRequirement::Forbidden` → 拒绝 |

### 策略引擎做什么

`execpolicy` crate 的 `Policy`（[policy.rs:28](C:\temp_project\codex\codex-rs\execpolicy\src\policy.rs)）对命令做两类匹配：

1. **前缀规则（PrefixRule）**：匹配命令字符串前缀，如 `git:`、`npm:` 这类前缀定义。
2. **真实可执行文件路径**：解析 `which <cmd>` 后的真实路径再匹配——防止用别名/软链绕过规则。

策略文件是**用户/项目可配置的 JSON**，通过 config layer stack 加载（见 [Config-System](../Concepts/Config-System.md)），核心入口 `load_exec_policy`（[exec_policy.rs:641](C:\temp_project\codex\codex-rs\core\src\exec_policy.rs#L641)）。

### 深写：判定入口 create_exec_approval_requirement_for_command

这是第 1 关的**核心函数**（[exec_policy.rs:311](C:\temp_project\codex\codex-rs\core\src\exec_policy.rs#L311)），把 execpolicy 的三态决策映射成审批系统的三态要求：

```rust
pub(crate) async fn create_exec_approval_requirement_for_command(
    &self,
    req: ExecApprovalRequest<'_>,
) -> ExecApprovalRequirement {
    let commands = commands_for_exec_policy(req.command);   // ← 解析出所有命令段（含管道）
    self.create_exec_approval_requirement_for_parsed_commands(req, commands).await
}
```

内部的 `create_exec_approval_requirement_for_parsed_commands`（[exec_policy.rs:320](C:\temp_project\codex\codex-rs\core\src\exec_policy.rs#L320)）核心映射（教学注释 `// ←`）：

```rust
let evaluation = exec_policy.check_multiple_with_options(
    commands.iter(), &exec_policy_fallback, &match_options,   // ← 对每个命令段查策略
);

match evaluation.decision {
    Decision::Forbidden => ExecApprovalRequirement::Forbidden { reason: derive_forbidden_reason(...) },
    Decision::Prompt => {
        // 被 approval_policy 拒绝？→ Forbidden；否则 → NeedsApproval
        match prompt_is_rejected_by_policy(approval_policy, prompt_is_rule) {
            Some(reason) => ExecApprovalRequirement::Forbidden { ... },
            None => ExecApprovalRequirement::NeedsApproval { reason: derive_prompt_reason(...), ... },
        }
    }
    Decision::Allow => ExecApprovalRequirement::Skip {
        // 只有当每个命令段都被显式 allow 才绕过沙箱
        bypass_sandbox: commands.iter().all(|command| /* 每段都是 Allow */),
        ...
    },
}
```

**教学解读**（这是整个安全模型最精妙的一行）：

- `commands_for_exec_policy` 把 `echo a | rm -rf /` **拆成多个命令段**，逐段判定——避免 `allow echo` 连累后面的 `rm -rf` 放行。
- `Decision::Allow` 时 `bypass_sandbox` 只有当**所有段都被显式 allow** 才为 `true`。也就是说：**策略放行 ≠ 无条件放行**，通常仍然进沙箱，只是不需要人工审批。
- `Prompt` 遇到 `approval_policy="never"` 会被**拒绝**（`prompt_is_rejected_by_policy`），因为"绝不审批"模式下，任何需要审批的命令都等于禁止。

> 📌 深入：为什么拆成 `commands`（多段）判定这么重要？考虑 `git commit -m "$(rm -rf /)"`——命令替换。Codex 对命令的解析（`commands_for_exec_policy`）要识别这类嵌套执行。命令解析依赖 `shell-command` crate 的 `parse_command`。

---

## 第 2 关：审批 —— 谁在什么情况下说"行"

审批的**路由中枢**是 `Session::request_approval`（[approvals.rs:439](C:\temp_project\codex\codex-rs\core\src\tools\approvals.rs#L439)）。源码注释明确优先级（[approvals.rs:454-457](C:\temp_project\codex\codex-rs\core\src\tools\approvals.rs#L454-L457)）：

```
request_approval
  ├─ request_reviewer_approval          ← 路由到审阅者
  │    ├─ request_guardian_approval     ← Guardian（模型审阅者，自动审）
  │    └─ request_user_approval         ← 用户（TUI 弹窗）
  └─ hooks（PreToolUse hooks 先跑，可拦截/改写）
```

| 审阅者 | 谁 | 何时生效 |
|--------|-----|---------|
| Hooks | 用户配置的脚本 | 最先，有最终决定权 |
| Guardian | 自动审阅模型 | 配置 `approvals_reviewer` 时，自动判断危险度 |
| 用户 | 终端用户 | 兜底：一切最终由人说了算 |

**审批缓存**：`with_cached_approval` 允许对同一命令的重复调用复用之前的批准（`auto_amendment_allowed` 相关，见 exec_policy 的 `allow_prefix_rules`）。这是 UX 优化，但也是安全注意点——所以只有当模型**支持前缀规则**时才启用缓存。

> 🔗 审批在调用链中的位置：`ToolOrchestrator::run` 第 1 步（[Tools-System](Tools-System.md#④-审批--沙箱--重试深写)）。

---

## 第 3 关：沙箱 —— 进程隔离

### 沙箱类型

`sandboxing` crate 定义 `SandboxType`（[manager.rs:36-42](C:\temp_project\codex\codex-rs\sandboxing\src\manager.rs#L36-L42)）：

```rust
pub enum SandboxType {
    None,
    MacosSeatbelt,       // macOS: /usr/bin/sandbox-exec + Seatbelt profile
    LinuxSeccomp,        // Linux: bubblewrap / Landlock
    WindowsRestrictedToken,  // Windows: 受限令牌 + 私有桌面
}
```

平台选择逻辑 `get_platform_sandbox`（[manager.rs:62-76](C:\temp_project\codex\codex-rs\sandboxing\src\manager.rs#L62-L76)）：

```rust
pub fn get_platform_sandbox(windows_sandbox_enabled: bool) -> Option<SandboxType> {
    if cfg!(target_os = "macos") {
        Some(SandboxType::MacosSeatbelt)
    } else if cfg!(target_os = "linux") {
        Some(SandboxType::LinuxSeccomp)
    } else if cfg!(target_os = "windows") {
        if windows_sandbox_enabled { Some(SandboxType::WindowsRestrictedToken) } else { None }
    } else { None }
}
```

### 各平台实现

| 平台 | 机制 | 说明 |
|------|------|------|
| macOS | **Seatbelt**（`sandbox-exec`） | [seatbelt.rs](C:\temp_project\codex\codex-rs\sandboxing\src\seatbelt.rs) 生成 profile：可读写根、网络策略都由 profile 强制 |
| Linux | **bubblewrap** / **Landlock** | `bwrap` 需要 user namespace；Landlock 无需 root；WSL2 走 bubblewrap，WSL1 不支持（见 [core/README.md](C:\temp_project\codex\codex-rs\core\README.md)） |
| Windows | **受限令牌 + 私有桌面** | [spawn.rs:54](C:\temp_project\codex\codex-rs\sandboxing\src\spawn.rs#L54) 调 `codex_windows_sandbox::spawn_windows_sandbox_session_for_level` |

### 进程启动

`spawn_process`（[spawn.rs:42](C:\temp_project\codex\codex-rs\sandboxing\src\spawn.rs#L42)）是统一入口：Windows 走受限令牌会话，其余平台走 `codex_utils_pty` 的 pty/pipe 启动。

```rust
pub async fn spawn_process(request: SpawnRequest<'_>) -> Result<SpawnedProcess> {
    if request.sandbox == SandboxType::WindowsRestrictedToken {
        #[cfg(target_os = "windows")]
        {
            // Windows: 受限令牌 + 私有桌面，连 UI 都隔离（use_private_desktop）
            return codex_windows_sandbox::spawn_windows_sandbox_session_for_level(...);
        }
    }
    // 其余平台: pty 或 pipe 方式起进程
    if request.tty {
        codex_utils_pty::pty::spawn_process(...)
    } else if request.stdin_open {
        codex_utils_pty::pipe::spawn_process(...)
    } else { ... }
}
```

> 📌 深入（Linux 沙箱的「懒执行」细节，来自 [core/README.md](C:\temp_project\codex\codex-rs\core\README.md)）：
> - 期望二进制用 `arg0` 模拟 `codex-linux-sandbox`（见 `codex-arg0` crate）——当 `arg0` 是 `codex-linux-sandbox` 时，同一二进制切换成沙箱宿主进程角色。
> - bwrap 优先用 PATH 上的系统版本；太老就退回兼容路径；缺失则用仓库自带的 `codex-resources/bwrap`。
> - 无法创建 user namespace 时，会通过正常通知路径弹出启动警告。
> - WSL1 无法创建 user namespace，直接拒绝进入沙箱。

---

## 完整链路回顾（一条命令的完整旅程）

```
模型 → shell("npm install") 
  → unified_exec 工具（tools/handlers/unified_exec.rs）
  → execpolicy 判定: npm: allow（前缀规则）
  → ExecApprovalRequirement::Skip { bypass_sandbox: false }
  → ToolOrchestrator 选沙箱: LinuxSeccomp
  → spawn_process 沙箱内运行 npm install
  → 若 npm 想写项目目录外 → 被沙箱拦 → 二次尝试（orchestrator.rs:486-519 升级/绕过，需审批）
  → 结果回模型
```

---

## 关键坑 / 备注

- `Decision::Allow` 不等于「无沙箱」：`bypass_sandbox` 只在所有命令段都显式 allow 时才 true（[exec_policy.rs:419-433](C:\temp_project\codex\codex-rs\core\src\exec_policy.rs#L419-L433)）。
- `Prompt` + `approval_policy="never"` = 拒绝，不是「挂起等审批」。
- execpolicy 是**第一道**防线，沙箱是**最后一道**；前者管「能不能跑」，后者管「跑起来能碰到什么」。
- 网络策略（`network_policy`）由文件系统策略之外的 `network-sandbox-policy` 管控，且 attachment 拥有的网络策略不能被沙箱升级绕过（[orchestrator.rs:149-158](C:\temp_project\codex\codex-rs\core\src\tools\orchestrator.rs#L149-L158)）。

---

## 小结

- 三层防线：**策略（execpolicy）→ 审批（hooks/guardian/user）→ 沙箱（进程隔离）**。
- execpolicy 三态 `Allow/Prompt/Forbidden`；判定按**命令段**逐一匹配，防止 `|` 和命令替换绕过。
- 沙箱按平台选型：macOS Seatbelt / Linux bubblewrap+Landlock / Windows 受限令牌。
- **纵深防御**：任一层都不绝对可信，三层叠加才是完整边界。

## 下一步阅读

- 沙箱里的进程由谁管理 → [Context-and-Compaction](Context-and-Compaction.md)（`UnifiedExecProcessManager` 提及）或直接读 `core/src/unified_exec/`
- 配置里怎么定义权限 → [Config-System](../Concepts/Config-System.md)
- 模型客户端怎么发起这一切 → [Model-Client](Model-Client.md)
