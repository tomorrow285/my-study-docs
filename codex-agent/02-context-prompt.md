# 02 · 模型可见上下文（Context / Prompt）

> TL;DR：模型每次采样「看到」什么，由 **WorldState 渲染的上下文片段 + history 消息** 组成。本页深写 WorldState 机制、`ContextualUserFragment` trait、history 的裁剪与 6 条硬约束。配套：[01-agent-loop](./01-agent-loop.md)（这些内容何时组装）。

---

## 1. 模型输入的三块组成

| 块 | 来源 | 说明 |
|---|---|---|
| base_instructions | `Session::get_base_instructions`（[session/mod.rs:1294](../codex-rs/core/src/session/mod.rs)） | 系统提示词，作为 `Prompt` 独立字段（`turn.rs:1313` `build_prompt`） |
| 消息历史 | `clone_history().for_prompt(input_modalities)`（[turn.rs:369](../codex-rs/core/src/session/turn.rs)） | 从持久化 history 裁剪出当前窗口（见 §4） |
| 上下文注入 | WorldState 渲染的 fragments + 每 turn 的 skill/plugin/hook 注入 | 见 §2、§3 |

## 2. 核心机制深写：WorldState（增量上下文引擎）

### 是什么

`WorldState`（[context/world_state/mod.rs:285](../codex-rs/core/src/context/world_state/mod.rs)）是「模型可见的实时状态」集合——一个按稳定 ID 去重的有序 `IndexMap`，每个 section 是一个 `Box<dyn ErasedWorldStateSection>`：

```rust
pub(crate) struct WorldState {
    sections: IndexMap<&'static str, Box<dyn ErasedWorldStateSection>>,
}
```

每个 section 实现 `WorldStateSection` trait（`mod.rs:226`），核心是 **snapshot + render_diff**：

```rust
pub(crate) trait WorldStateSection: Send + Sync + 'static {
    const ID: &'static str;
    type Snapshot: DeserializeOwned + Serialize;
    fn snapshot(&self) -> Self::Snapshot;
    fn render_diff(&self, previous: PreviousSectionState<'_, Self::Snapshot>)
        -> Option<Box<dyn ContextualUserFragment>>;
}
```

### 为什么

根 `AGENTS.md` 规则 1「No history rewrite - the context must be built up incrementally」、规则 2「避免频繁改动导致 cache miss」的工程实现：**不重写历史，只追加「相对上一快照的差异」**。每次 turn 把 section 快照存进 rollout（RFC 7386 merge-patch，`mod.rs:313`），下一 turn 只渲染变化的部分。

### 证据

主要 section 与注入顺序（`session/world_state.rs:34` `build_world_state_for_step`，顺序即模型看到顺序）：

| 顺序 | Section | ID | 渲染时机 |
|---|---|---|---|
| 1 | ModelInstructionsState | `model` | 模型切换时注入 `<model_switch>` 指令（`world_state/model.rs:44` 只在 model 变化时 `render_diff`） |
| 2 | PersonalityState | `personality` | personality 未烘焙进 base 时 |
| 3 | TokenBudgetContext / ContextWindowGuidanceState | — | 上下文窗口提示 |
| 4 | AgentsMdState | `agents_md` | AGENTS.md 内容（增量 diff） |
| 5 | PermissionsState | `permissions` | 当前权限策略 |
| 6 | CollaborationModeState / EnvironmentsState / Apps / Plugins / Tools | — | 协作模式、环境、工具说明 |
| … | host_skills 等扩展 section | 扩展自定义 id | `add_extension_section` 特判插到 Permissions 之后（`mod.rs:369-381`） |
| 末 | MultiAgentUsageHintState / MultiAgentModeState | — | 多 agent 提示词（[05-multi-agent](./05-multi-agent.md)） |

差异渲染与落库（`session/mod.rs:3190` `record_step_world_state_if_changed`）：

```rust
let world_state_item = world_state_snapshot.merge_patch_from(&previous_snapshot).map(WorldStateItem::patch);
let items = crate::context_manager::updates::merge_contextual_fragments(
    world_state.render_diff(&previous_snapshot),
);
if !items.is_empty() {
    self.record_conversation_items(turn_context, &items).await;   // 只追加差异
}
```

测试：`world_state_tests.rs::render_diff_restores_the_typed_section_snapshot`（:102）。

### 边界与反例

- **首轮全量**：`reference_context_item.is_none()` 时走 `build_initial_context_with_world_state`（`session/mod.rs:3917`）全量注入；之后走 diff。
- **模型切换必须显式**：`ModelSwitchInstructions`（`<model_switch>` 标记）在首轮被插到 developer 消息**最前**（`session/mod.rs:3719-3723`，测试 `build_initial_context_prepends_model_switch_message`）。
- **重写只发生在受控处**：compact / rollback / `drop_last_n_user_turns`（`context_manager/history.rs:322`）才整体替换 items。

## 3. ContextualUserFragment（注入片段的契约）

### trait 定义

`codex-rs/context-fragments/src/fragment.rs:64`（core 在 `context/mod.rs:56` re-export）：

```rust
pub trait ContextualUserFragment {
    fn role(&self) -> &'static str;
    fn content_kind(&self) -> ContentItemKind;          // 稳定分类 "<feature>.<name>"
    fn requires_separate_message(&self) -> bool { false }
    fn markers(&self) -> (&'static str, &'static str);  // 如 ("<model_switch>", "</model_switch>")
    fn body(&self) -> String;
    fn type_markers() -> (&'static str, &'static str) where Self: Sized;
    // ...
}
```

**根 `AGENTS.md` 规则 6**：所有注入片段必须是 `core/context` 下的结构体并实现该 trait。最小合法实现见 `hook_additional_context.rs:15`（无 marker、仅 content_kind/role/body）。

### 生命周期（以 hook additionalContext 为例）

1. **创建**：`hook_runtime.rs:748` `additional_context_messages` 把每条字符串包成 `HookAdditionalContext::new(text)`（developer role，`content_kind = "hooks.additional_context"`）。
2. **进 history**：`record_additional_contexts`（`hook_runtime.rs:734`）→ `record_conversation_items` → `record_items_with_metadata`（`history.rs:186`，写入时即按预算截断）。
3. **进 prompt**：`for_prompt`（`history.rs:205`）返回 `ResponseItem` 列表 → `build_prompt` 作为 `Prompt.input`。

### 合并规则

`context_manager/updates.rs:32` `merge_contextual_fragments`：相邻且同 role 且都可合并（`requires_separate_message=false`）的 fragment 拼成一条消息；`requires_separate_message=true` 的独立成条。content_kind 写入消息 metadata（`internal_chat_message_metadata_passthrough`），服务端不支持时被剥离（`client.rs:969`）。

## 4. history：结构与裁剪

### 数据结构

`ContextManager`（[context_manager/history.rs:45](../codex-rs/core/src/context_manager/history.rs)）：`items: Arc<Vec<ResponseItemEnvelope>>`——**写时复制**（`Arc::make_mut`，测试 `cloned_history_shares_items_until_mutated`），写入时丢弃非 API 消息（system/CompactionTrigger/Other）。

### 有界性（规则 3、4 的落点）

- **写入时截断**：`process_item`（`history.rs:470`）对 `FunctionCallOutput`/`CustomToolCallOutput` 执行 `truncate_function_output_payload`（`policy * 1.2` 序列化预算）；policy 来自 `turn_context.model_info.truncation_policy`（默认 `{"mode":"bytes","limit":10000}`）。
- **按模态裁剪**：`normalize_history`（`history.rs:450`）保证「每个调用有对应输出、每个输出有对应调用」，并按 `input_modalities` 剥离不支持的图片/音频（测试 `for_prompt_strips_media_when_model_does_not_support_it`）。

### 发送前

`for_prompt(input_modalities)`（`history.rs:205`）→ `normalize_history` → 返回 `Vec<ResponseItem>`。这就是 `run_turn` 每轮发给模型的「当前视野」。

## 5. 6 条硬约束 → 代码落点对照

| 根 AGENTS.md 规则 | 代码落点 |
|---|---|
| 1. No history rewrite | WorldState 快照 diff + `record_step_world_state_if_changed`（只追加） |
| 2. Avoid cache misses | `render_diff` 只在变化时渲染；相邻同 role 合并成一条消息 |
| 3. Bounded size + hard cap | `process_item` 写入时截断；`MAX_ADDITIONAL_CONTEXT_VALUE_TOKENS = 1_000`（`additional_context.rs:6`） |
| 4. No items > 10K tokens | `TruncationPolicy`（默认 10_000 bytes，`model-provider/provider.rs:595` 测试值） |
| 5. >1K tokens 人工评审 | 流程性规则；`MULTI_AGENT_MODE_MAX_TOKENS = 400`、`COMPLETION_MESSAGE_MAX_TOKENS = 1_000` 等常量佐证 |
| 6. 必须是 core/context 的 fragment | `ContextualUserFragment` trait（`context-fragments/fragment.rs:64`）+ core re-export |

## 一句话总结

模型看到 = base_instructions + history（for_prompt 裁剪）+ WorldState 差异渲染的 fragments；WorldState 用「快照+diff」实现增量注入（不重写、少缓存 miss），所有注入片段都必须实现 `ContextualUserFragment`，且每个 item 有界、写入时截断。

## 下一步

- 这些内容何时被组装 → [01-agent-loop](./01-agent-loop.md)
- 上下文里的多 agent 提示词 → [05-multi-agent](./05-multi-agent.md)
