# 06 · 会话生命周期与持久化（Session & Persistence）

> TL;DR：agent 的「记忆」怎么存：**ThreadManager 管生命周期**、**rollout 是磁盘日志**、**thread-store 是读写抽象**、**state_db/graph-store 是索引**。读完你能说清 `codex resume` 与多 agent 树如何跨进程恢复。配套：[01-agent-loop](./01-agent-loop.md)（turn 内记录时机）。

---

## 1. 四件套分工

| 组件 | 路径 | 负责 |
|---|---|---|
| `ThreadManager` | [core/src/thread_manager.rs](../codex-rs/core/src/thread_manager.rs) | 线程生命周期：create/resume/fork，注册 `CodexThread` |
| rollout | `codex-rs/rollout/` + `core/src/rollout.rs` | 会话磁盘日志（JSONL，逐条 ResponseItem），目录 `$CODEX_HOME/sessions/` |
| thread-store | [codex-rs/thread-store](../codex-rs/thread-store) | 线程读写抽象（`ThreadStore` trait + `LocalThreadStore`） |
| state_db + graph-store | `codex-rs/state/` + `codex-rs/agent-graph-store/` | SQLite 索引（会话列表）+ 多 agent 父子边（Open/Closed） |

## 2. ThreadStore trait（读写契约）

[thread-store/src/store.rs:68](../codex-rs/thread-store/src/store.rs)：

```rust
pub trait ThreadStore: Any + Send + Sync {
    async fn create_thread(...);
    async fn resume_thread(...);
    async fn append_items(...);
    async fn flush_thread(...);
    async fn load_history(...);
    async fn load_latest_model_context(...);
    // ...
}
```

- `live_thread.rs`：内存中的活动线程。
- `local/`：`LocalThreadStore` 落地实现。
- Session 创建/恢复：`session.rs:892` `LiveThread::create` / `session.rs:911` `LiveThread::resume`。

## 3. 生命周期全景

```mermaid
flowchart LR
    A["ThreadManager.start_thread (thread_manager.rs:906)"] --> B["start_thread_inner (937)"]
    B --> C["Session::spawn → LiveThread::create"]
    C --> D["submission_loop 运行 turn"]
    D --> E["append_items 逐条落盘 + 后台 flush"]
    E --> F["codex resume"]
    F --> G["resume_thread_from_rollout (thread_manager.rs:997)"]
    G --> H["InitialHistory::Resumed"]
    H --> I["spawn_thread 复用或重建 (1858)"]
```

| 环节 | 代码位置 | 作用 |
|---|---|---|
| 启动线程 | `thread_manager.rs:906` `start_thread` | 门面 |
| 通用启动 | `thread_manager.rs:937` `start_thread_inner` | 解析 session source、构造 `ThreadSpawnRequest` |
| 实际创建 | `thread_manager.rs:1823` `spawn_thread` | 创建 `CodexThread`（含独立 Session）并注册 |
| 恢复 | `thread_manager.rs:997` `resume_thread_from_rollout` → `:1235` `read_thread_by_rollout_path(include_history:true)` | 读回历史 |
| 运行中复用 | `thread_manager.rs:1858` `is_resumed_thread`：已在运行则直接复用 | 避免重复会话 |

## 4. resume 的身份恢复

Session 恢复身份（`session.rs:743-778`）：
- thread_id ← `resumed_history.conversation_id`
- session_id ← 从 `RolloutItem::SessionMeta` 恢复

所以 **rollout 是「事实源」**，session_id/thread_id 都从它还原；state_db 只做索引（会话列表、引用）。

## 5. 多 agent 树的持久化

`AgentGraphStore`（[agent-graph-store/src/store.rs:17](../codex-rs/agent-graph-store/src/store.rs)）：

```rust
pub trait AgentGraphStore: Send + Sync {
    fn upsert_thread_spawn_edge(&self, parent_thread_id: ThreadId, child_thread_id: ThreadId, status: ThreadSpawnEdgeStatus) -> ...;
    fn set_thread_spawn_edge_status(&self, child_thread_id: ThreadId, status: ThreadSpawnEdgeStatus) -> ...;
    fn list_thread_spawn_children(&self, parent_thread_id: ThreadId, status_filter: Option<ThreadSpawnEdgeStatus>) -> ...;
    fn list_thread_spawn_descendants(&self, root_thread_id: ThreadId, status_filter: Option<ThreadSpawnEdgeStatus>) -> ...;
}
```

边状态：`Open` / `Closed`（`types.rs:7`）。关键消费点：
- 写边：`control/spawn.rs:738` `persist_thread_spawn_edge_for_source`。
- 恢复整棵树：`control/spawn.rs:1090` `resume_agent_from_rollout` 用 `list_thread_spawn_descendants(Open)` BFS 重开所有未关闭子代理（测试 `control_tests.rs:4259` `resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown`）。

> 这解释了多 agent 的跨进程恢复：manager 重启后，根 rollout 还原根 agent，graph-store 里的 Open 边还原整棵子代理树。

## 6. 会话管理操作

| 操作 | 机制 |
|---|---|
| `codex resume [--last]` | 恢复会话（picker 或最近一个） |
| `codex fork [--last]` | 分叉会话（新线程从旧 history 继续） |
| `codex queue` | 向已有会话排队消息 |
| `codex archive / unarchive` | 归档（`ARCHIVED_SESSIONS_SUBDIR`）/ 恢复 |
| `codex delete [--force]` | 删除（`--force` 仅限 UUID） |

## 7. 关键坑

- **history 不可重写**：rollout 是 append-only；「截断」操作（`truncate_rollout_after_turn_id` 等，`thread_rollout_truncation.rs`）生成新状态而非原地编辑。
- **运行态 ≠ 磁盘态**：`core/src/state/` 的 `SessionState`/`TurnState` 是内存态；崩溃恢复的是最近 flush 的 history。
- **fork 的历史清洗**：子代理 fork 时只继承「干净」的 history（丢工具中间过程），见 [05-multi-agent](./05-multi-agent.md) 的 §2。

## 一句话总结

agent 的记忆 = rollout（JSONL 日志，事实源）+ thread-store（读写抽象）+ state_db（索引）+ graph-store（多 agent 树）；`resume` 从 rollout 还原身份与历史，多 agent 树靠 Open 边 BFS 重开；所有「改写」只发生在受控的 compact/truncation 路径。

## 下一步

- turn 内记录时机 → [01-agent-loop](./01-agent-loop.md)
- fork 时的历史清洗 → [05-multi-agent](./05-multi-agent.md)
