# 05 · 多 Agent（子代理与协作）

> TL;DR：Codex 的 agent 可以 **fork 出子代理**并行干活：父 agent 用 `spawn_agent` 创建子线程，通过**邮箱**收发消息，`wait_agent` 阻塞等待。本页深写 AgentControl、fork 清洗、通信协议与 V1/V2 两代。配套：[06-session-persistence](./06-session-persistence.md)（线程拓扑落盘）。

---

## 1. 概念与角色

| 角色 | 是什么 |
|---|---|
| `AgentControl` | 多 agent 控制面（[core/src/agent/control.rs:107](../codex-rs/core/src/agent/control.rs)）：整棵 root 树共享一个实例，提供 spawn、通信、限额 |
| `AgentRegistry` | 限额与索引（[registry.rs:25](../codex-rs/core/src/agent/registry.rs)）：限制每个用户会话的子代理总数、维护 agent 树 |
| `AgentPath` | 树状路径（`/root`、`/root/sub`、`/root/sub/sub`，[protocol/src/agent_path.rs:18](../codex-rs/protocol/src/agent_path.rs)） |
| 子代理 | **独立的 Session/线程**，与父共享同一 AgentControl |
| `AgentGraphStore` | 父/子边（Open/Closed）持久化（[agent-graph-store/src/store.rs:17](../codex-rs/agent-graph-store/src/store.rs)） |

> 注意：`agent-identity` crate **与多 agent 内存机制无关**——它是云端身份认证（注册 agent 身份、签发 JWT）。

## 2. 核心机制深写：AgentControl（控制面）

### 是什么

`AgentControl`（control.rs:107-129）每棵 root/session 树至多创建一次，所有子代理共享：

```rust
/// Control-plane handle for multi-agent operations.
/// An `AgentControl` instance is intended to be created at most once per root thread/session
/// tree. That same `AgentControl` is then shared with every sub-agent spawned from that root,
/// which keeps the registry scoped to that root thread rather than the entire `ThreadManager`.
```

字段：`session_id`（整棵树统一）、`manager: Weak<ThreadManagerState>`（Weak 防循环引用）、`state: Arc<AgentRegistry>`、`agent_execution_limiter`（并发额度，`control/execution.rs:14`）。

### 子代理生成（两条路径）

| 路径 | 入口 | 用途 |
|---|---|---|
| 工具 `spawn_agent`（V2 实际路径） | `control/spawn.rs:582` `spawn_agent_internal` → fork 走 `spawn_forked_thread`（`:788`），非 fork 走 `spawn_new_thread_with_source` | 多 agent 工具调用 |
| ThreadManager 层 | `thread_manager.rs:962` `spawn_subagent`（注释 `// TODO(jif) merge with fork_agent`） | 旧版 fork 封装 |

**fork = fork 父的持久化历史**，但要做**历史清洗**（`control/spawn.rs:62` `keep_forked_rollout_item`）：只保留 system/developer/user 消息、assistant 的 FinalAnswer、无 call_id 的 FunctionCallOutput；丢弃中间工具调用、推理、InterAgentCommunication；并从 developer 消息剥掉多 agent 提示词（`:102` `retain_forked_developer_message`）——**子代理不继承父的协作状态**。

### 限额（AgentRegistry）

- `reserve_spawn_slot`（registry.rs:96）：`total_count >= max_threads` 时返回 `AgentLimitReached`。
- 深度限制：`exceeds_thread_spawn_depth_limit`（registry.rs:79，测试 `registry_tests.rs:48`）。
- 昵称池：`agent_names.txt`（101 个科学家名字）随机分配，用尽加序数后缀（测试 `registry_tests.rs:217`）。

## 3. 核心机制深写：父子通信（邮箱）

### 是什么

子代理之间/父子之间通过 **InterAgentCommunication 消息 + 每 Session 一个输入邮箱** 通信：

```rust
// protocol/src/protocol.rs:745
pub struct InterAgentCommunication {
    pub id: Option<ResponseItemId>,
    pub author: AgentPath,
    pub recipient: AgentPath,
    pub other_recipients: Vec<AgentPath>,
    pub content: String,
    pub trigger_turn: bool,
}
```

### 发送与投递

1. **发送**：`AgentControl::send_inter_agent_communication`（control.rs:218）→ `state.send_op(agent_id, Op::InterAgentCommunication{...})`（control.rs:330）。
2. **投递**：目标 Session 的 `session/handlers.rs:604` 处理 `Op::InterAgentCommunication` → `enqueue_mailbox_communication`（`input_queue.rs:121`）压进邮箱。
3. **唤醒**：`trigger_turn=true` 时 `drain_mailbox_input_items`（`input_queue.rs:151`）把邮箱转成 `TurnInput::InterAgentCommunication` 唤醒一轮 turn；`InputQueueActivity` 只有两态：`Mailbox` / `Steer`。

### 父如何等待子结果（两条机制）

| 机制 | 说明 | 位置 |
|---|---|---|
| **Completion watcher** | spawn 后 `maybe_start_completion_watcher`（control.rs:570）后台轮询子状态到 `is_final`；V2 向直接父发 `FINAL_ANSWER` 消息，V1 注入 `<subagent_notification>` fragment | `session_prefix.rs:19` `format_inter_agent_completion_message` |
| **`wait_agent` 工具** | 模型主动阻塞等待邮箱活动 | `tools/handlers/multi_agents_v2/wait.rs:36` |

`wait_agent` 的核心（`wait.rs:184` `wait_for_activity`）：`timeout_at(deadline, activity_rx.changed())`，返回 `MailboxActivity`（有子消息）/ `Steered`（用户打断）/ `TimedOut`。

### 测试证据

- `control_tests.rs:3006` `spawn_child_completion_notifies_parent_history`（V1）
- `control_tests.rs:3145` `multi_agent_v2_completion_queues_message_for_direct_parent`（V2）
- `control_tests.rs:1449` `spawn_agent_can_fork_parent_thread_history_with_sanitized_items`（fork 清洗）
- `control_tests.rs:2393` `spawn_agent_fork_last_n_turns_keeps_only_recent_turns`（V2 按 fork_turns 截断）

## 4. V1 vs V2 两代多 agent

| 维度 | V1 | V2 |
|---|---|---|
| 工具命名空间 | `multi_agent_v1` 前缀（`multi_agents_spec.rs:14`） | 默认无 namespace（可配 `multi_agent_v2.tool_namespace`） |
| 工具集 | `spawn_agent`/`send_input`/`resume_agent`/`wait_agent`/`close_agent` | `spawn_agent`/`send_message`/`followup_task`/`wait_agent`/`interrupt_agent`/`list_agents` |
| 完成通知 | `<subagent_notification>` user fragment 注入父 | `FINAL_ANSWER` 消息发给直接父 |
| 上下文传播 | 默认全量 fork | `fork_turns` 控制传播轮数（`SpawnAgentForkMode::LastNTurns`） |
| 启用条件 | 受 `agent_max_depth` 限制 | 根 agent 或模型声明支持 V2（`spec_plan.rs:596` `collab_tools_enabled`） |

**角色提示词**（V2，`session/multi_agents.rs:11-59` 内嵌）：
- root（/root，orchestrator 语义）：「You are `/root`, the primary agent in a team of agents…你可以 `spawn_agent` 创建新 agent、`followup_task` 下发新任务并触发 turn、`send_message` 传消息而不触发 turn…」。
- subagent：「When you provide a response in the final channel, that content is immediately delivered back to your parent agent」。

注入时机：`session/world_state.rs:277` 每轮 turn 构建 world state 时注入 `MultiAgentModeState` + `MultiAgentUsageHintState`。

## 5. 内置角色（agent-roles）

`core/src/agent/role.rs:355` `built_in::configs()`：

| 角色 | 行为要点（role.rs 内嵌 description） |
|---|---|
| `default` | 无 config_file |
| `explorer` | 「并行 spawn 多个 explorer、互不等待、可继续本地工作」——**并行探查** |
| `worker` | 「显式分配任务所有权；不独自在代码库中、别回退他人修改」——**分工** |

角色覆盖（`role.rs:51` `apply_role_to_config`）**只能收窄不能扩大父权限**（role.rs:1-4 注释）：「Roles may customize the child or reduce its capabilities, but never replace the parent session's authority」。可覆盖：model、personality、developer_instructions、features（仅能 disable 部分）、skills（仅能禁用）。角色 TOML 作为一层 `SessionFlags` 配置插入（`role.rs:240`）。

用户自定义角色：`agent-roles` crate（`agent_role_config.rs:38` `parse_agent_role_file_contents`）从磁盘发现解析。

## 6. 协作模式模板（单 agent 的多 agent 编排习惯）

`collaboration-mode-templates/templates/`（`lib.rs` 导出 `PLAN`/`DEFAULT`）：
- `plan.md`：三阶段对话式规划（环境探查 → 意图对话 → 实现细节），最终以 `<proposed_plan>` 块输出「决策完整」的计划，明确「do not ask 'should I proceed?'」。
- `default.md`：模式切换仅由 `<collaboration_mode>` 开发者消息触发；倾向「做出合理假设并执行」而非反问。

> 注意：Plan **协作模式** ≠ `update_plan` **工具**（[03-tools](./03-tools.md) 的边界节）。

## 一句话总结

多 agent = 每棵 root 树一个共享 `AgentControl`（限额+通信+spawn），子代理是独立 Session 且 fork 时清洗历史；父子经邮箱收发 `InterAgentCommunication`，父可 `wait_agent` 阻塞等待或用 completion watcher 收 `FINAL_ANSWER`；V2 引入 `fork_turns` 上下文传播控制与无命名空间工具集，编排习惯（并行 explorer / 分工 worker）由内置角色描述驱动。

## 下一步

- 线程拓扑如何落盘与恢复 → [06-session-persistence](./06-session-persistence.md)
- 多 agent 提示词在上下文里的注入 → [02-context-prompt](./02-context-prompt.md)
