# 核心模块 · 会话与线程模型（Session / Thread / CodexThread）

> **TL;DR**：Codex 用 `ThreadManager` 管理多个会话；每个会话 = `CodexThread`（对外的双向消息导管）+ `Session`（内部运行时）+ `SessionIo`（事件通道）。你发消息就变成 `Op` 提交进去。会话内部的三层循环见 [Agent-Turn-Loop](Agent-Turn-Loop.md)。

**对应源码**：`codex-rs/core/src/` 下的 [thread_manager.rs](C:\temp_project\codex\codex-rs\core\src\thread_manager.rs)、[codex_thread.rs](C:\temp_project\codex\codex-rs\core\src\codex_thread.rs)、[session/](C:\temp_project\codex\codex-rs\core\src\session)

---

## 为什么需要四个对象？

学生第一次看这个项目最常见的困惑是：**为什么既有 Thread 又有 Session 还有 CodexThread？**

答案藏在设计里——它们**分层解决不同问题**：

| 对象 | 一句话职责 | 类比 |
|------|-----------|------|
| `ThreadManager` | 所有会话的**注册表 + 工厂**，能建、能恢复、能 fork | 酒店前台 |
| `CodexThread` | 一个会话的**对外门面**：你只跟它打交道，`submit(op)` 就完事 | 房卡/门牌 |
| `Session` | 一个会话的**内部运行时**：真正干活的循环、状态都在这里 | 房间里的房间设施 |
| `SessionIo` | Session 与外界交换消息的**通道对**（提交 + 事件） | 对讲机 |

而每个「会话」在用户眼里就是一个**对话线程（thread，旧称 conversation）**。多 agent 协作时，一个主 thread 可以 `spawn_subagent` 产生**子 thread**，子 thread 同样有自己的 `Session`。这就是为什么需要 ThreadManager 来统一管理——它维护着一个 `HashMap<ThreadId, Arc<CodexThread>>`。

```
ThreadManager (前台)
   ├── ThreadId #1 → CodexThread ──► Session ──► submission_loop
   ├── ThreadId #2 → CodexThread ──► Session ──► submission_loop
   └── ThreadId #3(子agent) → CodexThread ──► Session ──► submission_loop
```

---

## 启动链：从 `codex` 命令到会话诞生

完整调用链（证据见各文件）：

```
codex (cli/src/main.rs:1064 main)
  └─ cli_main (cli/src/main.rs:1072)
      └─ run_interactive_tui (cli/src/main.rs:2583)
          └─ codex_tui::run_main (tui/src/lib.rs:933)
              └─ run_main_inner (tui/src/startup_orchestration.rs:8)
                  └─ run_ratatui_app (tui/src/lib.rs:959)
                      └─ app_server_session::start_thread_with_request_handle
                          └─ (app-server 协议)
                             ThreadManager::start_thread (thread_manager.rs:906)
                               └─ ThreadManagerState::spawn_thread (thread_manager.rs:1823)
                                   └─ Session::spawn (session/mod.rs:473)
                                       └─ tokio::spawn(submission_loop) (session/mod.rs:794)
```

关键代码——`ThreadManager` 启动线程的入口（[thread_manager.rs:906](C:\temp_project\codex\codex-rs\core\src\thread_manager.rs#L906)）：

```rust
pub async fn start_thread(&self, options: StartThreadOptions) -> CodexResult<NewThread> {
    Box::pin(self.start_thread_inner(options, /*forked_from_thread_id*/ None)).await
}
```

`Session::spawn` 返回两个东西（[session/mod.rs:473](C:\temp_project\codex\codex-rs\core\src\session\mod.rs#L473)）：

```rust
pub(crate) async fn spawn(args: SessionSpawnArgs) -> CodexResult<(Arc<Self>, SessionIo)>
//                            ▲                               ▲            ▲
//                   启动参数（配置/认证/工具等）      Session 本体    事件通道对
```

> 📌 深入：`SessionIo` 持有 `tx_sub`（提交 Op 的通道）、`rx_event`（事件接收端）、`agent_status`（watch 状态）和 `session_loop_termination`（循环结束信号）。`CodexThread::new` 把 `Session` + `SessionIo` 包起来（[codex_thread.rs:229](C:\temp_project\codex\codex-rs\core\src\codex_thread.rs#L229)），对外只暴露 `CodexThread` 这一个门面。**你在 TUI 之外看到的所有「对会话的操作」最终都变成 `CodexThread::submit(Op)`**。

---

## CodexThread：门面（你唯一要打交道的对象）

[codex_thread.rs:202](C:\temp_project\codex\codex-rs\core\src\codex_thread.rs#L202)：

```rust
pub struct CodexThread {
    pub(crate) session: Arc<Session>,
    pub(crate) io: SessionIo,
    pub(crate) session_source: SessionSource,
    session_configured: SessionConfiguredEvent,
    rollout_path: Option<PathBuf>,
    out_of_band_elicitations: Mutex<OutOfBandElicitations>,
    _diagnostics_guard: GaugeGuard,
}
```

源码注释点明了它的定位（[codex_thread.rs:226](C:\temp_project\codex\codex-rs\core\src\codex_thread.rs#L226)）：

> "Conduit for the bidirectional stream of messages that compose a thread (formerly called a conversation) in Codex."
> （构成一个 thread 的双向消息流导管，旧称 conversation。）

对外核心方法只有几个：

| 方法 | 作用 |
|------|------|
| `submit(op)` | 提交一个 `Op`（TurnInput / Interrupt / Shutdown …），返回 submission id |
| `start_or_steer_turn()` | 提交 `TurnInputRequest`，开始或转向一个 turn |
| `shutdown_and_wait()` | 优雅关停 |
| `wait_until_terminated()` | 等循环结束 |

> 💡 **理解要点**：`CodexThread` 本身**不做任何智能决策**。它只是把 `Op` 从外部世界送进 `Session` 的通道，再把事件送出来。所有决策都在 `Session` 内部。

---

## Session：内部运行时（裁判）

`Session` 是真正承载状态的对象。源码注释（[session/session.rs:39](C:\temp_project\codex\codex-rs\core\src\session\session.rs#L39)）：

> "A session has at most 1 running task at a time, and can be interrupted by user input."
> （一个 session 同一时刻最多有一个 running task，可被用户输入打断。）

它的核心字段（[session/session.rs:40-71](C:\temp_project\codex\codex-rs\core\src\session\session.rs#L40-L71)，教学注释用 `// ←` 标记）：

```rust
pub(crate) struct Session {
    pub(crate) thread_id: ThreadId,
    pub(crate) installation_id: String,
    pub(super) tx_event: Sender<Event>,            // ← 向外部（TUI）发事件
    pub(super) agent_status: watch::Sender<AgentStatus>,  // ← 状态广播（可被订阅）
    pub(super) state: Mutex<SessionState>,         // ← 会话级可变状态（配置/历史指针等）
    pub(super) features: ManagedFeatures,          // ← 特性开关（会话生命周期内不变）
    pub(crate) conversation: Arc<RealtimeConversationManager>,  // ← 实时对话管理
    pub(crate) active_turn: Mutex<Option<ActiveTurn>>,   // ← 当前运行中的 turn（最多一个！）
    pub(crate) async_hook_results: async_channel::Receiver<HookCompletedEvent>,
    pub(crate) input_queue: InputQueue,            // ← 待处理输入队列
    pub(crate) guardian_review_session: GuardianReviewSessionManager,  // ← 自动审阅
    pub(crate) services: SessionServices,          // ← 聚合一堆共享服务
    // ... 还有 mcp 预暖、git 策略等
}
```

> 📌 深入：`SessionServices` 把几乎所有依赖聚合到一起——`model_client`（模型客户端）、`extensions`（扩展）、`mcp_runtime`、`unified_exec_manager`、`agent_control`、`rollout_thread_trace`、`session_telemetry` 等。读代码时遇到 `session.services.xxx` 就是在访问这些共享服务。这是 Rust 里常见的「服务容器」模式，避免每个函数传十几二十个参数。

---

## 概念辨析：Thread / Session / Turn / Step（易卡点）

这四个词的层级关系，是读懂这个项目的前提：

```
Thread（线程/对话）       = 一次完整对话，可跨多个 Turn，持久化在 rollout 里
  └─ Turn（回合）         = 一次「用户输入 → Agent 干完活 → 停下」的完整响应周期
       └─ Step（步骤）    = 一次「采样请求 + 该次采样触发的一批工具调用」
            └─ Op（操作） = 提交给 Session 的最小指令单元（TurnInput/Interrupt/...）
```

| 词 | 生命周期 | 谁创建 | 说明 |
|----|---------|--------|------|
| Thread | 进程级（可恢复） | `ThreadManager::start_thread` | 一个对话，有 `ThreadId` |
| Turn | 会话级 | `turn_input::start_or_steer` | 有 `sub_id`（submission id）；一个 Session 同时最多一个 active turn |
| Step | turn 内 | `run_turn` 循环内 | 一次采样 = 一个 step，`StepContext` 是它的快照 |
| Op | 瞬时 | 调用方 | `Op::TurnInput` 等，走 `CodexThread::submit` |

> 理解 `Turn` 和 `Step` 的区别特别重要：一个 turn 通常含**多个 step**——模型采样一次，调用几个工具，拿到结果再采样一次，这就算下一个 step 了，直到模型输出最终答案结束 turn。

---

## 提交 Op：消息怎么进去的

当你发一条消息，流程是：

```
你发消息
  → CodexThread::submit(Op::TurnInput { request, mode, reply })
  → SessionIo.tx_sub.send(sub)          // 送进通道
  → Session::spawn 起的 submission_loop 从 rx_sub.recv() 拿到
  → turn_input::handle(...)              // 分发到"开始/转向/空闲才启动"三种模式
  → Session::spawn_task(...)             // 起一个 turn 任务
  → RegularTask::run → run_turn          // 进入核心循环
```

> 🔗 循环内部怎么走，是项目灵魂，**全部展开在 [Agent-Turn-Loop](Agent-Turn-Loop.md)**。这里只讲到这里。

---

## 生命周期速查

| 事件 | 发生什么 |
|------|---------|
| 进程启动 | `ThreadManager` 创建（进程级，只一次） |
| 新建对话 | `start_thread` → `Session::spawn` → `tokio::spawn(submission_loop)` → 得 `CodexThread` |
| 对话中 | `CodexThread::submit(op)` → `submission_loop` 分发 |
| `codex resume` | `resume_thread_from_rollout` 用 rollout 历史重建 `Session`（见 [Rollout](../Concepts/Rollout.md)） |
| `codex fork` | `fork_thread` 从旧线程复制历史开新线程 |
| 关停 | `Op::Shutdown` 使 `submission_loop` 退出 |

---

## 小结

- 四对象各司其职：**ThreadManager 管生命周期，CodexThread 当门面，Session 干决策，SessionIo 传消息**。
- 一切外部操作都是 `submit(Op)`；`Session` 内部有一个事件泵（`submission_loop`）在消费这些 Op。
- 层级记忆：**Thread → Turn → Step → Op**，一个 Turn 多个 Step。

## 下一步阅读

- 进入灵魂 → [Agent-Turn-Loop](Agent-Turn-Loop.md)
- 看工具怎么被调用 → [Tools-System](Tools-System.md)
- 会话记录怎么持久化 → [Rollout](../Concepts/Rollout.md)
