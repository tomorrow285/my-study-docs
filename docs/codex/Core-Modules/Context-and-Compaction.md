# 核心模块 · 上下文管理与压缩（世界状态 / Compaction）

> **TL;DR**：每次采样前，Codex 把「人格 + 工具列表 + AGENTS.md + 历史 + 环境」打包成一份 **WorldState（世界状态）** 注入给模型；当历史太长、token 超限时，**compaction（压缩）** 把旧内容浓缩后继续。读完你能说出：世界状态由谁在什么时机构建、超限时谁触发压缩、压缩去哪。

**对应源码**：`codex-rs/core/src/session/world_state.rs`、`codex-rs/core/src/context/`、`codex-rs/core/src/context_manager/`、`codex-rs/core/src/compact.rs`

> 前置知识：读完 [Agent-Turn-Loop](Agent-Turn-Loop.md)，知道每次采样叫一个 step，`StepContext` 是它的快照。

---

## 0. 两个容易混的概念

| 概念 | 谁 | 生命周期 | 一句话 |
|------|----|---------|--------|
| `StepContext`（[step_context.rs:18](C:\temp_project\codex\codex-rs\core\src\step_context.rs#L18)） | 一次采样请求的**请求作用域快照** | 一个 step | 模型信息、审批策略、`tool_router`、AGENTS.md 等 |
| `WorldState`（[context/world_state/mod.rs](C:\temp_project\codex\codex-rs\core\src\context\world_state\mod.rs)） | **注入给模型的内容块集合** | 每次采样重建 | 人格、工具列表、AGENTS.md 渲染成的文本片段 |

> 记忆技巧：**StepContext 是「关于这次请求的元数据」，WorldState 是「喂给模型的正文」**。`StepContext` 里装着 `tool_router`（怎么调工具），`WorldState` 里装着告诉模型「你能用哪些工具」的文本。

---

## 1. 世界状态怎么构建

构建入口 `build_world_state_for_step`（[world_state.rs:34](C:\temp_project\codex\codex-rs\core\src\session\world_state.rs#L34)），教学注释 `// ←`：

```rust
#[tracing::instrument(name = "world_state.build", level = "info", skip_all)]
pub(crate) async fn build_world_state_for_step(
    &self,
    step_context: &StepContext,
) -> CodexResult<WorldState> {
    let turn_context = step_context.turn.as_ref();
    let model_instructions = turn_context
        .model_info
        .get_model_instructions(turn_context.personality);   // ← 按模型+人格取基础指令
    let (previous_model, previous_context, base_instructions) = { /* 上一轮的模型/上下文 */ };

    let personality_is_baked = turn_context.model_info.supports_personality()
        && base_instructions == model_instructions;

    let mut world_state = WorldState::default();
    world_state.add_section(ModelInstructionsState::new(        // ← 段 1：模型指令
        &turn_context.model_info.slug,
        previous_model.as_deref(),
        model_instructions,
    ));
    if self.features.enabled(Feature::Personality) {
        // 段 2：人格（若模型支持 personality）
        world_state.add_section(PersonalityState::new(...));
    }
    // ... 后面还有 ToolsState（工具列表）、AgentsMdState（AGENTS.md）、
    //     EnvironmentsState（环境）、AppsInstructionsState（apps 指令）等
    Ok(world_state)
}
```

**教学解读**：
- `WorldState` 是一个**可以 `add_section` 的分段容器**，每段是独立的状态类型（`ModelInstructionsState` / `PersonalityState` / `ToolsState` / `AgentsMdState` / `EnvironmentsState` …）。这是**组合式上下文构建**——各段独立维护、按需启用。
- 为什么用「段」？因为不同的模型/特性组合，需要不同的注入内容。`features.enabled(Feature::Personality)` 这种开关决定了哪些段被加进去。
- **在 turn 循环里**，`world_state` 只在**变化时**重新构建并记录（`record_step_world_state_if_changed`，[turn.rs:365](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L365)）——避免每个 step 都重算。

> 📌 深入：`get_model_instructions` 按模型取基础指令——不同模型（GPT-5.x 等）有不同的基础 prompt。这些 prompt 文件就在仓库里：`codex-rs/core/gpt_5_2_prompt.md`、`gpt_5_1_prompt.md` 等。`model_info` 是模型目录（`models-manager` crate）提供的，描述了模型能力、prompt、输入模态。

---

## 2. 上下文管理器：历史怎么组织

`context_manager`（`core/src/context_manager/`）负责**上下文历史与更新**：

| 文件 | 职责 |
|------|------|
| `history.rs` | 历史项的构建与访问 |
| `updates.rs` | 上下文增量更新 |
| `normalize.rs` | 历史规范化 |

> 📌 深入：模型看到的历史由 `sess.clone_history().for_prompt(...)` 提供（[turn.rs:370-373](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L370-L373)）——每次采样前克隆当前历史，按模型**输入模态**（文本/图像/音频）过滤后作为采样输入。这保证「发给模型的东西」与「模型实际能接收的东西」一致。

---

## 3. Compaction：上下文太长怎么办（深写）

### 是什么

对话变长后，token 逼近上下文窗口上限。Compaction 把历史**浓缩**（摘要/丢弃旧细节），让对话能继续而不炸窗口。

### 为什么

- LLM 上下文窗口有硬上限；超了要么报错、要么截断（丢信息）。
- Codex 的答案：**在将爆未爆时主动压缩**——保留关键信息，抛弃细枝末节。

### 怎么触发的

turn 循环里的自动压缩（[turn.rs:458-498](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L458-L498)），教学注释 `// ←`：

```rust
let should_roll_over = needs_follow_up
    && (sess.take_new_context_window_request().await || token_limit_reached);  // ← 两个触发源

// as long as compaction works well in getting us way below the token limit,
// we shouldn't worry about being in an infinite loop.
if should_roll_over {
    if let Err(err) = run_auto_compact(
        &sess,
        Arc::clone(&step_context),
        /*fallback_step_context*/ None,
        &mut client_session,
        InitialContextInjection::BeforeLastUserMessage {   // ← 压缩后把上下文插回最后一条用户消息前
            world_state: Arc::clone(&world_state),
            step_context: Arc::clone(&step_context),
        },
        CompactionReason::ContextLimit,    // ← 触发原因
        CompactionPhase::MidTurn,          // ← turn 中途压缩
    ).await { ... }
    can_drain_pending_input = !model_needs_follow_up;
    continue;                              // ← 压缩完，继续下一轮采样
}
```

**触发时机**（两个触发源 + 一个用户源）：

| 触发 | 原因 | 位置 |
|------|------|------|
| `token_limit_reached` | token 超限 | turn.rs:459 |
| `take_new_context_window_request` | 请求换新上下文窗口 | turn.rs:459 |
| 用户 `/compact` | 手动请求 | `session/handlers.rs:243` → `CompactTask` |

### 怎么实现

`compact.rs` 的核心是 `run_compact_task`（[compact.rs:148](C:\temp_project\codex\codex-rs\core\src\compact.rs#L148)）→ `run_compact_task_inner_impl`（`:245`）。压缩分两类：

| 类型 | 说明 | 相关文件 |
|------|------|---------|
| 本地压缩 | 用本会话模型直接摘要 | `compact.rs` |
| 远端压缩（Remote Compaction） | 交给服务端压缩（V2） | `compact_remote*.rs` |

远端压缩的能力由 `ModelProvider::capabilities()` 声明（`RemoteCompactionSupport::V2`，见 [Model-Client](Model-Client.md#2-后端抽象modelprovider-trait)）——OpenAI/Azure 支持 V2，其他 provider 不支持（走本地压缩）。

> 📌 深入：压缩不是无脑截断，而是**有预算**的决策。`compact_token_budget.rs`、`context_window.rs` 负责算「还剩多少 token、压缩后要降到多少」。注释（turn.rs:469）说明设计前提：**只要压缩能把 token 降到远低于上限，就不会死循环**——这是「压缩→继续→再压缩」循环能收敛的保证。

---

## 4. 关键坑 / 备注

- **StepContext ≠ WorldState**：前者是请求元数据，后者是注入正文（见第 0 节）。
- 压缩是「**主动触发**」而非「爆了才处理」：`token_status.will_exceed()` 在超限前就预判。
- `run_auto_compact` 用 `InitialContextInjection::BeforeLastUserMessage`——压缩后的世界状态插在**最后一条用户消息之前**，保证模型「还记得刚发生的事」。
- 如果压缩失败且错误是 `TurnAborted`，直接返回错误；否则发错误事件后结束当前采样（turn.rs:485-492）。

---

## 小结

- **WorldState** = 每次采样前重建的分段注入内容（指令/人格/工具/AGENTS.md…）。
- **Compaction 触发链**：token 预判超限 → `run_auto_compact` → 本地/远端压缩 → 插回 `BeforeLastUserMessage` → continue。
- 压缩收敛的前提：**压缩结果要远低于 token 上限**。

## 下一步阅读

- AGENTS.md 和 Skills 怎么进世界状态 → [Skills-and-AgentsMd](../Concepts/Skills-and-AgentsMd.md)
- 会话记录怎么持久化 → [Rollout](../Concepts/Rollout.md)
- 配置怎么影响这一切 → [Config-System](../Concepts/Config-System.md)
