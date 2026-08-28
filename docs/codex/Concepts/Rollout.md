# 概念 · Rollout（会话记录）

> **TL;DR**：每个 Codex 会话的所有事件按顺序追加写成一个 **JSONL 文件**（`rollout-<时间戳>-<uuid>.jsonl`），这就是 rollout。`codex resume` / `codex fork` 都靠它恢复历史。读完你能说出：一条消息/工具调用/错误事件怎么变成文件里的一行 JSON，以及它怎么支撑「续聊」和「分支」。

**对应源码**：`codex-rs/rollout/` crate（[recorder.rs](C:\temp_project\codex\codex-rs\rollout\src\recorder.rs)）

---

## 是什么：一个可回放的会话磁带

Rollout 本质是**只追加（append-only）的 JSONL 事件日志**。源码注释（[recorder.rs:1](C:\temp_project\codex\codex-rs\rollout\src\recorder.rs#L1)）：

> "Persist Codex session rollouts (.jsonl) so sessions can be replayed or inspected later."
> （持久化 Codex 会话 rollout（.jsonl），以便之后重放或检查。）

文件位置与命名（[recorder.rs:82](C:\temp_project\codex\codex-rs\rollout\src\recorder.rs#L82) 示例）：

```
~/.codex/sessions/rollout-2025-05-07T17-24-21-5973b6c0-94b8-487b-a530-2aeb6098ae0e.jsonl
```

> 每行一个 JSON 对象，对应一个 `RolloutItem`（消息、工具调用、工具结果、元数据行…）。用 `jq -C . <文件>` 就能浏览整个会话的原始记录。

---

## 谁在写：RolloutRecorder

`RolloutRecorder`（[recorder.rs:86](C:\temp_project\codex\codex-rs\rollout\src\recorder.rs)）是写入者，关键方法：

| 方法 | 作用 |
|------|------|
| `persist()`（:971） | 追加写一批 items 到文件 |
| `flush()`（:992） | 刷盘，保证落到磁盘 |
| `load_rollout_items()`（:1009） | 读回整个 rollout |
| `get_rollout_history()`（:1074） | 取历史（给 resume 用） |

> 📌 深入：写入是**异步 mpsc 队列**（recorder.rs import `tokio::sync::mpsc`）——调用方把 item 塞进队列，后台任务真正写盘。这避免每次事件都阻塞主循环；`flush()` 用于关键时刻（如 turn 结束、关停前）保证落盘。`SESSIONS_SUBDIR` / `ARCHIVED_SESSIONS_SUBDIR` 区分活动/归档会话。

---

## 谁在读：resume 与 fork

Rollout 是「续聊」和「分支」的数据源：

```
codex resume <thread>   → ThreadManager::resume_thread_from_rollout
                            → 读 rollout JSONL → 重建 Session 历史 → 继续对话

codex fork <thread>     → ThreadManager::fork_thread
                            → 从 rollout 复制历史 → 新 ThreadId
```

| 操作 | 用途 | 数据源 |
|------|------|--------|
| resume | 恢复上次的对话 | rollout 历史 |
| fork | 从历史分叉出新对话 | rollout 历史 |

---

## 与周边概念的关系

- **thread-store**（`thread-store` crate）：负责 thread 的持久化/索引（`LocalThreadStore::create_thread` 等），rollout 是它的底层记录格式。
- **core 里的 rollout.rs**：只是 re-export 层 + 给 `RolloutConfigView` 实现 Config，真正的逻辑都在 `rollout` crate。
- **rollout-trace**：rollout 的追踪扩展（trace bundle、replay），用于调试/观测。

> 🔗 ThreadManager 的 resume/fork 方法位置：[thread_manager.rs:997](C:\temp_project\codex\codex-rs\core\src\thread_manager.rs#L997) `resume_thread_from_rollout`、[thread_manager.rs:1210](C:\temp_project\codex\codex-rs\core\src\thread_manager.rs#L1210) `fork_thread`。

---

## 小结

- Rollout = **JSONL 追加日志**，每行一个会话事件，可回放、可检查。
- 写入走**异步队列**，`persist` 入队、`flush` 落盘。
- **resume / fork 都靠它**——它是「AI 的记忆文件」。

## 下一步阅读

- 线程怎么持久化 → 直接读 `codex-rs/thread-store/`
- 回到主循环 → [Agent-Turn-Loop](../Core-Modules/Agent-Turn-Loop.md)
