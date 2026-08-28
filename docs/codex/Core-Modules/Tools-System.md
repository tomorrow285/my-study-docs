# 核心模块 · 工具系统（Agent 的「手」）

> **TL;DR**：模型不会自己动手，只能「请求」调用工具。Codex 的 `ToolRegistry` 存工具、`ToolRouter` 转发、`ToolOrchestrator` 负责审批+沙箱+重试、`ToolCallRuntime` 做并行门控。读完你能说出：一个工具从注册到执行，经过哪五个环节、各自在哪个文件哪个函数。

**对应源码**：`codex-rs/core/src/tools/` 下的 [spec_plan.rs](C:\temp_project\codex\codex-rs\core\src\tools\spec_plan.rs)、[registry.rs](C:\temp_project\codex\codex-rs\core\src\tools\registry.rs)、[router.rs](C:\temp_project\codex\codex-rs\core\src\tools\router.rs)、[orchestrator.rs](C:\temp_project\codex\codex-rs\core\src\tools\orchestrator.rs)、[parallel.rs](C:\temp_project\codex\codex-rs\core\src\tools\parallel.rs)、[approvals.rs](C:\temp_project\codex\codex-rs\core\src\tools\approvals.rs)

> 前置知识：读完 [Agent-Turn-Loop](Agent-Turn-Loop.md)，知道工具调用发生在第三层的 `try_run_sampling_request`。

---

## 0. 一条主线：工具的生命周期

工具系统可以浓缩成**五个环节**，本文按这个顺序讲：

```
① 注册（建 registry）
   spec_plan.rs: build_tool_router → add_core_tool_sources（内置工具 + MCP + 扩展 + 动态工具）
② 发现（让模型知道有什么）
   build_model_visible_specs → 生成 ToolSpec 列表 → 随采样请求发给模型
③ 调用（模型请求 → 转成 ToolCall）
   router.rs: build_tool_call → dispatch_tool_call_with_terminal_outcome
④ 审批 + 沙箱 + 重试（安全关口）
   orchestrator.rs: ToolOrchestrator::run（approval → select sandbox → retry）
⑤ 执行（真正干活）
   registry.rs: dispatch_any_with_terminal_outcome → handle_any_tool → tool.handle(invocation)
```

> 一句话：**注册 → 发现 → 调用 → 审批 → 执行**。①和②是准备，③④⑤是运行时。

---

## ① 注册：每个 step 建一个新的 registry

关键事实：**工具注册表是「每 step 重建」的**，不是全局一份。因为不同 step 的上下文（MCP 服务器、可用环境、动态工具）可能不同。

`build_tool_router`（[spec_plan.rs:117](C:\temp_project\codex\codex-rs\core\src\tools\spec_plan.rs#L117)）：

```rust
pub(crate) fn build_tool_router(
    session: &Session,
    turn_context: &TurnContext,
    environments: &TurnEnvironmentSnapshot,
    mcp: &Arc<codex_mcp::McpBinding>,
    apps_enabled: bool,
    step_store: &ExtensionData,
    tool_suggest_candidates: Option<&crate::tools::router::ToolSuggestCandidates>,
) -> CodexResult<ToolRouter> {
    // ...
    let mut registry = ToolRegistry::default();        // ← 空注册表
    add_core_tool_sources(&context, &mut registry);    // ← 1. 内置工具（shell/apply_patch/plan/sleep...）

    let hosted_specs = if crate::guardian::is_basic_session_source(&turn_context.session_source) {
        Vec::new()
    } else {
        let registered_mcp_tools = session.services.mcp_handler_cache.append_mcp_tools(  // ← 2. MCP 工具
            mcp, &turn_context.config, apps_enabled, &mcp.config().mcp_server_catalog,
            search_tool_enabled(turn_context), &mut registry,
        );
        apply_mcp_tool_exposure_policy(turn_context, mcp, &registered_mcp_tools, &mut registry);
        let standalone_web_search_tool = append_extension_tool_executors(                // ← 3. 扩展工具
            turn_context, extension_tool_executors(session, step_store), &mut registry,
        );
        append_dynamic_tool_runtimes(&turn_context.dynamic_tools, &mut registry);        // ← 4. 动态工具
        hosted_model_tool_specs(turn_context, standalone_web_search_tool.as_slice())
    };

    finalize_tool_router(turn_context, registry, hosted_specs, &session.services.tool_search_handler_cache)
}
```

**工具来源有四种**，学习时注意区分：

| 来源 | 例子 | 谁注册 |
|------|------|--------|
| 内置核心工具 | `shell`、`apply_patch`、`plan`、`sleep`、`request_user_input` | `add_core_tool_sources` |
| MCP 工具 | 通过 Model Context Protocol 接入的外部工具 | `mcp_handler_cache.append_mcp_tools` |
| 扩展工具 | Codex 扩展注入的工具 | `append_extension_tool_executors` |
| 动态工具 | 运行时临时工具 | `append_dynamic_tool_runtimes` |

> 📌 深入：`finalize_tool_router`（[spec_plan.rs:313](C:\temp_project\codex\codex-rs\core\src\tools\spec_plan.rs#L313)）把 registry + 模型可见的 specs 打包成 `ToolRouter`，存进 `StepContext.tool_router`。之后这个 step 内的所有工具调用都用它。`ToolRouter` 结构很简单（[router.rs:68](C:\temp_project\codex\codex-rs\core\src\tools\router.rs#L68)）：`registry` + `model_visible_specs` 两份东西。

---

## ② 发现：模型怎么知道有什么工具

模型看不到 registry，它只看到 `ToolSpec` 列表（工具的名字、描述、JSON schema 参数）。这就是「广告给模型的能力」。

```
build_model_visible_specs (spec_plan.rs:483)
  → Vec<ToolSpec>
  → ToolRouter.model_visible_specs() (router.rs:109)
  → 随采样请求（Prompt）一起发给模型
```

`ToolRouter` 持有的 `model_visible_specs: Arc<[ToolSpec]>`（[router.rs:70](C:\temp_project\codex\codex-rs\core\src\tools\router.rs#L70)）就是给模型看的那份清单。

> 💡 **理解要点**：模型输出「调 `shell`」时，Codex 把它转成 `ToolCall`，然后 `tool_supports_parallel` 决定能否并行、`tool_runtime` 找到对应的 handler。这两个查询都走 `ToolRouter`（[router.rs:137-145](C:\temp_project\codex\codex-rs\core\src\tools\router.rs#L137-L145)）。

---

## ③ 调用：从模型响应到 ToolCall

模型流式输出 `FunctionCall` 后，`build_tool_call`（[router.rs:148](C:\temp_project\codex\codex-rs\core\src\tools\router.rs#L148)）把它转成内部的 `ToolCall`：

```rust
pub fn build_tool_call(item: ResponseItem) -> Result<Option<ToolCall>, FunctionCallError> {
    match item { ... }   // ← 解析工具名 + 参数 JSON
}
```

> 🔗 完整调用链（`ToolCallRuntime.handle_tool_call` 并行门控 → 深度细节）在 [Agent-Turn-Loop](Agent-Turn-Loop.md#5-第-3-层) 的第三层已经讲了入口；这里是它落地后的下一跳。

---

## ④ 审批 + 沙箱 + 重试（深写）

这是工具系统**最值得深读**的机制。`ToolOrchestrator` 的模块头注释自述为 **"approval + sandbox selection + retry 的集中点"**（[orchestrator.rs:40](C:\temp_project\codex\codex-rs\core\src\tools\orchestrator.rs#L40)）。

### 是什么

`run()` 对一个工具调用做三件事：**先审批、再进沙箱尝试、被拦就二次尝试**。

### 怎么实现的

[orchestrator.rs:125](C:\temp_project\codex\codex-rs\core\src\tools\orchestrator.rs#L125)，教学注释 `// ←`：

```rust
pub async fn run<Rq, Out, T>(
    &mut self,
    tool: &mut T,                    // ← 要执行的工具（实现了 ToolRuntime）
    req: &Rq,
    tool_ctx: &ToolCtx,
    turn_ctx: &crate::session::turn_context::TurnContext,
    approval_policy: AskForApproval,
) -> Result<OrchestratorRunResult<Out>, ToolError>
where T: ToolRuntime<Rq, Out>,
{
    // 1) Approval
    let mut already_approved = false;
    let environment = tool.turn_environment(req);
    let file_system_sandbox_policy = environment.permission_profile_with_workspace_roots().file_system_sandbox_policy();
    let requirement = tool.exec_approval_requirement(req).unwrap_or_else(|| {
        default_exec_approval_requirement(approval_policy, &file_system_sandbox_policy)
    });
    match &requirement {
        ExecApprovalRequirement::Skip { .. } => {
            // 配置直接放行：strict_auto_review 时仍需 Guardian 自动审
            // 否则直接 otel.tool_decision(Approved, source=Config)
        }
        ExecApprovalRequirement::Forbidden { reason } => {
            return Err(ToolError::Rejected(reason.clone()));   // ← 策略禁止，直接拒绝
        }
        ExecApprovalRequirement::NeedsApproval { reason, .. } => {
            let action = tool.approval_action(req, &tool_ctx.call_id)?;
            let approval_ctx = ApprovalContext { /* ... */ };
            tool_ctx.session.request_approval(action, approval_ctx).await?;   // ← 走审批
            already_approved = true;
        }
    }

    // 2) First attempt under the selected sandbox.
    let unsandboxed_allowed = !owner_network_policy && unsandboxed_execution_allowed(&file_system_sandbox_policy);
    let sandbox_override = if unsandboxed_allowed {
        sandbox_override_for_first_attempt(tool.sandbox_permissions(req), &requirement, &file_system_sandbox_policy)
    } else {
        SandboxOverride::NoOverride
    };
    // ... select_initial 选沙箱 → 第一次尝试 ...

    // 3) 若被沙箱拒绝 → 二次尝试（升级/绕过沙箱），见 orchestrator.rs:486-519
}
```

**审批判定来源**：`exec_approval_requirement` 返回三态之一——`Skip`（放行）、`Forbidden`（拒绝）、`NeedsApproval`（要人/机审）。对于执行类工具，这个判定来自 **execpolicy**（见 [Execution-Sandbox](Execution-Sandbox.md)）。

**审批者优先级**（[approvals.rs:454-457](C:\temp_project\codex\codex-rs\core\src\tools\approvals.rs#L454-L457) 注释，核心要点）：

```
Session::request_approval
  ├─ Hooks（PreToolUse hooks 有最终决定权）
  ├─ Guardian（自动审阅者，可放行危险度低的调用）
  └─ 用户（TUI 弹窗 / 审批预设）
```

| 审批结果 | 后续 |
|---------|------|
| 允许 | 进沙箱执行 |
| 拒绝 | 工具返回拒绝错误给模型 |
| 沙箱拦截 | `orchestrator.rs:486-519` 二次尝试：提示「retry without sandbox?」走升级审批 |

> 📌 深入：`default_exec_approval_requirement` 依据 `approval_policy`（`AskForApproval`：Never / OnUnrestricted / OnFailure / Always）与沙箱策略决定是否需要审批。**沙箱越强，需要的审批越少**——这是 Codex 安全模型的核心权衡。详见 [Execution-Sandbox](Execution-Sandbox.md)。

---

## ⑤ 执行：dispatch 到真正的 handler

`ToolRegistry::dispatch_any_with_terminal_outcome`（[registry.rs:479](C:\temp_project\codex\codex-rs\core\src\tools\registry.rs#L479)）是执行入口，教学注释 `// ←`：

```rust
pub(crate) async fn dispatch_any_with_terminal_outcome(
    &self,
    mut invocation: ToolInvocation,
    terminal_outcome_reached: Option<Arc<AtomicBool>>,
) -> Result<AnyToolResult, FunctionCallError> {
    let tool_name = invocation.tool_name.clone();
    // ...（计数、telemetry 标签、sandbox 标签）...

    let tool = match self.tool(&tool_name) {
        Some(tool) => tool,                    // ← 从 registry 找 handler
        None => {
            // 没找到：返回"回复模型"的错误（不是致命错误，让模型换工具）
            return Err(FunctionCallError::RespondToModel(message));
        }
    };
    if !tool.matches_kind(&invocation.payload) {
        // 找到了但参数类型不匹配 → 致命错误
        return Err(FunctionCallError::Fatal(message));
    }

    if let Some(pre_tool_use_payload) = tool.pre_tool_use_payload(&invocation) {
        match run_pre_tool_use_hooks(...).await {    // ← PreToolUse hooks 有机会拦截/改写
            PreToolUseHookResult::Blocked(message) => {
                return Err(FunctionCallError::RespondToModel(message));  // ← hook 拦截
            }
            PreToolUseHookResult::Continue { updated_input: Some(updated_input) } => {
                invocation = updated_invocation;      // ← hook 改写输入
            }
            // ...
        }
    }
    // ...
    tool.handle(invocation).await                    // ← 最终调用 handler 本体
}
```

**教学解读**：
- **找不到工具 ≠ 致命错误**：返回 `FunctionCallError::RespondToModel`，模型可以换个工具或换个说法重试。**找到了但参数不匹配 = 致命错误**（这是代码 bug 或模型幻觉）。
- `pre_tool_use_payload` 提供 hooks 拦截点：PreToolUse hook 可以 `Blocked`（拦截）或 `Continue`（改写输入）。这是企业安全控制的关键钩子。
- `tool.handle(invocation)` 是真正执行的地方，比如 `ExecCommandHandler` 执行 shell 命令（走 [Execution-Sandbox](Execution-Sandbox.md) 的沙箱）。

---

## 并行门控：ToolCallRuntime 的关键设计

`ToolCallRuntime`（[parallel.rs:41](C:\temp_project\codex\codex-rs\core\src\tools\parallel.rs#L41)）持有 `parallel_execution: Arc<RwLock<()>>`——**一个读写锁充当并行门**：

```rust
let _guard = if supports_parallel {
    Either::Left(lock.read().await)     // ← 支持并行的工具：多个读锁并行跑
} else {
    Either::Right(lock.write().await)   // ← 不支持并行的工具：写锁串行化
};
```

| 工具类型 | 锁 | 效果 |
|---------|-----|------|
| 支持并行（如多个 `sleep`、只读命令） | 读锁 | 并发执行 |
| 不支持并行（如修改同一文件的工具） | 写锁 | 全局串行 |

> 💡 **为什么用 `RwLock<()>` 而不是 Mutex**：Rust 的 `RwLock` 天然支持「多读单写」。Codex 让「并行安全」的工具走读锁、「需要互斥」的工具走写锁，用最少的代码实现了工具级并行控制。

---

## 关键坑 / 备注

- 每个 step 重建 registry：工具集是**上下文相关**的，不是全局固定。
- `dispatch` 前会记录 `active_turn.turn_state.tool_calls` 计数，并维护 `terminal_outcome_reached`——多 agent 场景下保证「一次工具调用只有一处收尾」。
- 并行工具的产出顺序由 `FuturesOrdered` 保证**按完成顺序**返回，不是按发起顺序。

---

## 小结

- 工具五环节：**注册 → 发现 → 调用 → 审批 → 执行**。
- `ToolOrchestrator::run` 是三关集中点：**审批 → 选沙箱 → 被拦就重试**。
- 找不到工具返回「回复模型」（可重试），参数不匹配返回「致命」（真 bug）。
- `RwLock<()>` 并行门：并行工具读锁并发，非并行工具写锁串行。

## 下一步阅读

- 审批与沙箱的底层策略 → [Execution-Sandbox](Execution-Sandbox.md)
- 模型如何「看到」这些工具并输出调用 → [Model-Client](Model-Client.md)
- MCP 是什么 → 官方 [MCP 文档](https://modelcontextprotocol.io)（外部资料）
