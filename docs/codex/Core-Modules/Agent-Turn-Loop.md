# 核心模块 · Agent 三层循环（项目灵魂）

> **TL;DR**：Codex 的"智能"是三层套娃循环：`submission_loop`（会话事件泵）→ `run_turn`（一次 turn 的采样-执行-再采样）→ `try_run_sampling_request`（流式响应解析+工具分发）。读完你能复述：一条消息进来后，在哪一层、由哪个函数、怎么变成模型的一次次工具调用。

**对应源码**：`codex-rs/core/src/session/` 下的 [handlers.rs](C:\temp_project\codex\codex-rs\core\src\session\handlers.rs)、[turn_input.rs](C:\temp_project\codex\codex-rs\core\src\session\turn_input.rs)、[turn.rs](C:\temp_project\codex\codex-rs\core\src\session\turn.rs)

> 前置知识：先读完 [Session-and-Thread](Session-and-Thread.md)，知道 `Session`、`CodexThread`、`Op`、`Turn`、`Step` 是什么。

---

## 0. 从最简单的情况开始

任何 Agent 循环，本质都是这三步：

```rust
// 伪代码：最简 agent 循环
loop {
    let user_input = wait_for_user_input();
    let response = model.generate(user_input);     // ① 采样
    execute_tools(response.tool_calls);            // ② 执行工具
    // ③ 回到 ①，直到模型输出最终答案
}
```

Codex 的实现也是这三步，只是套了三层壳，各司其职。下面一层层拆开。

---

## 1. 三层循环总览

```
┌─────────────────────────────────────────────────────────────┐
│ 第 1 层  submission_loop  (session 级, 常驻)                  │
│  session/handlers.rs:514                                     │
│  一个 Session 起一个，while 循环接收 Op 并分发                 │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 第 2 层  run_turn  (turn 级, 一次 turn 一个)               │ │
│  │  session/turn.rs:153 / 主循环在 :301                      │ │
│  │  loop { 取输入 → 构建 step_context → 采样 → 检查是否继续 }    │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │ 第 3 层  try_run_sampling_request (step 级)          │ │ │
│  │  │  session/turn.rs:2180                                │ │ │
│  │  │  stream.next() 逐事件 → 收集工具调用 → 派发执行         │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

| 层 | 生命周期 | 核心函数 | 一句话职责 |
|----|---------|---------|-----------|
| 1 | 会话常驻 | `submission_loop` | 事件泵：接收所有 `Op`（消息/中断/关停） |
| 2 | 一次 turn | `run_turn` | 主循环：反复「采样 + 工具」，直到 turn 结束 |
| 3 | 一次采样 | `try_run_sampling_request` | 流式解析响应，把工具调用送去执行 |

---

## 2. 第 1 层：submission_loop —— 会话事件泵

`Session::spawn` 时用 `tokio::spawn` 拉起，是整个会话的主事件源（[handlers.rs:514](C:\temp_project\codex\codex-rs\core\src\session\handlers.rs#L514)）：

```rust
pub(super) async fn submission_loop(
    sess: Arc<Session>,
    config: Arc<Config>,
    rx_sub: Receiver<Submission>,          // ← 接收外部提交的 Op
) {
    // To break out of this loop, send Op::Shutdown.
    let mut shutdown_received = false;
    while let Ok(sub) = rx_sub.recv().await {     // ← 阻塞等待下一个 Op
        debug!(?sub, "Submission");
        let dispatch_span = submission_dispatch_span(&sub);
        let should_exit = async {
            match sub.op {
                Op::Interrupt => { interrupt(&sess).await; false }
                Op::CleanBackgroundTerminals => { clean_background_terminals(&sess).await; false }
                // ... 其他实时会话 Op ...
                Op::TurnInput { request, mode, reply } => {
                    let result = turn_input::handle(&sess, *request, mode, sub.id.clone()).await;
                    let _ = reply.send(result);      // ← 通过 reply 通道把结果回给调用方
                    false
                }
                Op::SuspendTurnAndShutdown { reply } => {
                    // ... 挂起并退出；只有真正持久化成功才 should_exit=true ...
                    should_exit
                }
                Op::Shutdown => true,               // ← 只有它让循环退出
                // ...
            }
        }.await;
        if should_exit { break; }
    }
}
```

**教学解读**：
- 这是一个**生产者-消费者**模式：外部（TUI、子 agent、测试）通过 `CodexThread::submit` 往通道里塞 `Submission`，这个循环是唯一消费者。
- 每个 `Op` 处理完返回 `bool` 的 `should_exit`，绝大多数是 `false`；只有 `Op::Shutdown`（或挂起成功）才让循环退出。
- `Op::TurnInput` 是**最重要的分支**——它把用户消息转交给 `turn_input::handle`，返回结果通过 `reply` 这个 oneshot 通道交回调用方。这就是异步通信：`submit` 不等循环干完活，而是等 `reply`。

> 📌 深入：`Submission` 和 `Op` 定义在 `protocol` crate（[protocol/src/protocol.rs:187](C:\temp_project\codex\codex-rs\protocol\src\protocol.rs#L187) `Submission`、`:545` `Op`）。`Submission` 除了 `op` 还有 `id`、`parent_turn_id` 等元数据——多 agent 场景下，子 agent 的消息会带父 turn 的信息。

---

## 3. 进入 turn：turn_input 的三种启动模式

`submission_loop` 收到 `Op::TurnInput` 后调用 [turn_input.rs:140](C:\temp_project\codex\codex-rs\core\src\session\turn_input.rs#L140)：

```rust
pub(super) async fn handle(
    session: &Arc<Session>,
    request: TurnInputRequest,
    mode: TurnInputMode,                      // ← 关键：三种模式之一
    submission_id: String,
) -> CodexResult<TurnInputSubmission> {
    match mode {
        TurnInputMode::StartOrSteer => start_or_steer(session, request, submission_id).await,
        TurnInputMode::StartIfIdle => {
            start_if_idle(session, request, submission_id, /*is_recovery*/ false).await
        }
        TurnInputMode::Steer { expected_turn_id } => {
            steer(session, request, expected_turn_id, submission_id).await
        }
    }
}
```

三种模式解决一个实际问题：**用户可能在 agent 正在干活时发新消息**。此时该「加入当前 turn 转向」还是「等空闲再开始」？三种策略：

| 模式 | 语义 | 典型场景 |
|------|------|---------|
| `StartOrSteer` | 有活跃 turn 就转向，没有就新开 | 用户随便发消息 |
| `StartIfIdle` | 只在空闲时新开 turn | 自动恢复、后台任务 |
| `Steer { expected_turn_id }` | 必须转向指定 turn | UI 明确指向某个 turn |

`start_or_steer` 的关键分支（[turn_input.rs:194](C:\temp_project\codex\codex-rs\core\src\session\turn_input.rs#L194)）：

```rust
match session.steer_input(&mut items, /*expected_turn_id*/ None, ...).await {
    Ok(turn_id) => {
        // 有活跃 turn → 作为转向输入并入当前 turn
        settings.apply_steered(session, submission_id).await?;
        Ok(TurnInputSubmission::Steered { turn_id })
    }
    Err(NotSubmittedReason::NoActiveTurn) => {
        // 没有活跃 turn → 真正启动一个新 turn
        let turn_context = settings.apply_started(session, submission_id.clone()).await?;
        // ...
        let mut task_input = merge_additional_context_input(session, additional_context).await;
        if !items.is_empty() {
            task_input.push(TurnInput::UserInput { content: items, client_id });
        }
        session.spawn_task(turn_context, task_input, RegularTask::new()).await;  // ← 起 turn 任务
        Ok(TurnInputSubmission::Started { turn_id: submission_id })
    }
    Err(reason) => Ok(TurnInputSubmission::NotSubmitted { reason }),
}
```

**教学解读**：`steer_input` 尝试把输入并入活跃 turn；只有拿到 `NoActiveTurn` 才会新开 turn。新 turn 由 `Session::spawn_task` + `RegularTask` 承载——`RegularTask::run`（[tasks/regular.rs:39](C:\temp_project\codex\codex-rs\core\src\tasks\regular.rs#L39)）最终调用 `run_turn`，把执行流交给第 2 层。

---

## 4. 第 2 层：run_turn —— turn 主循环（深写）

这是整个项目**最核心的一段逻辑**。用 skill 的五段式写透。

### ① 是什么

`run_turn` 管理一次 turn 的完整生命周期：**反复「取输入 → 构建上下文快照 → 采样 + 执行工具 → 检查是否还有后续」，直到模型给出最终答案或被打断**。

### ② 为什么这样设计

- **为什么要循环**：LLM 一次采样可能只是要调用一个工具，不是最终答案。必须把工具结果喂回去再采样，直到模型满意。
- **为什么要区分 step**：每次采样前都要重新构建「世界状态」（新工具列表、新历史、新 MCP 上下文），所以每次采样 = 一个 step，各自有独立的 `StepContext` 快照。
- 注释（[turn.rs:302](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L302)）特别提醒：`pending_input` 可能是用户在模型运行期间通过 UI 提交的消息，**UI 支持但模型未必支持**——这是设计约束。

### ③ 怎么实现的

主循环在 [turn.rs:300-419](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L300-L419)（教学注释用 `// ←`）：

```rust
let mut next_step_context = Some(first_step_context);
loop {
    // 取用户/系统挂起的新输入（模型运行期间 UI 提交的消息）
    let pending_input = if can_drain_pending_input {
        sess.input_queue.get_pending_input(&sess.active_turn).await.0
    } else {
        Vec::new()
    };

    if run_hooks_and_record_inputs(&sess, &turn_context, &pending_input, PersistContext::Standard).await {
        break;                                    // ← 结束 turn（比如用户要求停止）
    }

    // 捕获一次"世界状态"快照（人格/工具列表/AGENTS.md/历史……）
    // 同一个 step 的上下文、广告的工具、工具调用必须来自同一份快照
    let step_context = match next_step_context.take() {
        Some(step_context) => step_context,
        None if pending_input.is_empty() => {
            sess.capture_step_context(Arc::clone(&turn_context), &cancellation_token).await?
        }
        None => { /* 有 pending 输入时额外带上必需的 MCP 服务器 */ ... }
    };

    let sampling_request_result: CodexResult<_> = async {
        // 记录世界状态（若变化）
        world_state = sess.record_step_world_state_if_changed(&world_state, step_context.as_ref()).await?;
        // 构建发给模型的输入：历史转换 + 元数据
        let sampling_request_input: Vec<ResponseItem> = ...;
        let responses_metadata = ...;
        // ★ 核心：发起一次采样（第 3 层），并执行其中所有工具
        run_sampling_request(Arc::clone(&sess), Arc::clone(&step_context), ...,
            &mut client_session, &responses_metadata, sampling_request_input, ...).await
    }.await;

    match sampling_request_result {
        Ok((sampling_request_output, _)) => {
            let SamplingRequestResult { needs_follow_up, .. } = sampling_request_output;
            if needs_follow_up { /* 模型还要继续 → 允许接收邮箱投递 */ }
            can_drain_pending_input = true;
            // 检查是否还有 pending 输入 / token 是否超限
            let (has_pending_input, token_status) = ...;
            if has_pending_input { continue; }      // ← 有新输入，继续采样
            if token_status.will_exceed() {          // ← token 要爆了
                run_auto_compact(&sess, &turn_context, &mut client_session, &mut turn_store,
                    &mut turn_diff_tracker, &cancellation_token).await?;
                continue;                            // ← 压缩后继续（见 Context-and-Compaction）
            }
            // 没有后续 → 跑 stop hooks，结束 turn
            ...
            break;
        }
        Err(CodexErr::TurnAborted) => { break; }     // ← 用户 Ctrl+C
        Err(err) => { ... }
    }
}
```

**教学解读（逐段）**：
1. **取 pending_input**：检查有没有运行期间新到的输入。注意 `can_drain_pending_input` 这个门——模型还在输出时不一定允许插入输入。
2. **捕获 step_context**：每次采样前，把「模型指令、工具列表、AGENTS.md、环境快照」打包成一份 `StepContext`。这段代码强调了**一次采样必须共享同一份快照**——避免上下文、广告的工具、工具调用三者对不上。
3. **run_sampling_request**：把历史转成 `ResponseItem` 发给模型，处理流式响应和工具执行——这是第 3 层的入口。
4. **决定是否 continue**：
   - 有 pending 输入 → 继续下一轮
   - token 快超限 → `run_auto_compact` 压缩历史后继续
   - 都没有 → `break` 结束 turn

### ④ 边界与反例

| 场景 | 表现 |
|------|------|
| 用户 Ctrl+C | 采样被取消 → `CodexErr::TurnAborted` → break |
| token 超限 | `run_auto_compact` 压缩历史（远端/本地），continue |
| 运行期间用户发消息 | `can_drain_pending_input` 控制是否接受，接受则下一轮采样带上 |
| 模型一直要调工具 | 循环一直转，直到 `needs_follow_up=false` 或无 pending 输入 |

### ⑤ 常见误区

- ❌ 误以为「一次 turn = 一次采样」：**一个 turn 有多个 step**，每次 `run_sampling_request` 就是一个 step。
- ❌ 误以为「模型说了最终答案就立即结束」：还要检查 pending 输入和 token，`run_hooks_and_record_inputs` 的返回值也能提前 break。
- ❌ 混淆 `run_turn`（第二层，管整个 turn 流程）和 `run_sampling_request`（发起采样 + 工具执行）。前者是编排者，后者是执行者。

---

## 5. 第 3 层：try_run_sampling_request —— 流式处理与工具分发

`run_sampling_request` 会循环调用 `try_run_sampling_request`（每个尝试一次）。这是真正「和模型对话、把工具调用派发出去」的地方（[turn.rs:2180](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L2180)）：

```rust
async fn try_run_sampling_request(
    tool_runtime: ToolCallRuntime,              // ← turn 级工具执行器（Tools-System 会讲）
    sess: Arc<Session>,
    step_context: Arc<StepContext>,
    ...
    client_session: &mut ModelClientSession,    // ← turn 级模型会话（Model-Client 会讲）
    ...
) -> CodexResult<SamplingRequestResult> {
    ...
    // 调用模型客户端拿流式响应
    let mut stream = client_session
        .stream(prompt, &step_context.model_info, ..., responses_metadata, &inference_trace)
        .or_cancel(&cancellation_token)         // ← 取消令牌：Ctrl+C 生效的关键
        .await??;

    let mut in_flight: FuturesOrdered<BoxFuture<'static, CodexResult<ResponseInputItem>>> =
        FuturesOrdered::new();                  // ← 并发执行中的工具调用队列
    let mut needs_follow_up = false;
    let mut last_agent_message: Option<String> = None;
    // ...

    let outcome: CodexResult<SamplingRequestResult> = loop {
        // 逐事件读取流
        let event = match stream.next()
            .or_cancel(&cancellation_token).await
        {
            Ok(event) => event,
            Err(codex_async_utils::CancelErr::Cancelled) => break Err(CodexErr::TurnAborted),
        };
        // ... 根据事件类型处理：
        //    ResponseItem::FunctionCall / CustomToolCall / ToolSearchCall
        //    → handle_output_item_done → tool_runtime.handle_tool_call(...)
        //    → 把工具 future 塞进 in_flight
        //    ResponseItem::Message(assistant) → 流式累积 last_agent_message
        //    流结束 → break Ok(...)
    };
    // ...
}
```

**教学解读**：
- `client_session.stream(...)` 返回一个 `ResponseStream`（异步事件流），`loop { stream.next() }` 逐个消费事件。`or_cancel(&cancellation_token)` 是取消令牌——用户 Ctrl+C 时，等待中的 `next()` 返回 `Cancelled`，break 成 `TurnAborted`。
- 关键数据结构是 `in_flight: FuturesOrdered<...>`：**流还没读完，工具就已经开始并发执行了**。事件流告诉你「模型要调用工具」，`handle_tool_call` 立刻把它变成一个 future 塞进 `in_flight`，边读流边跑工具——这就是流式 agent 和同步 agent 的核心差异。
- `handle_tool_call` 的并行门控、审批、沙箱选择，全部在 [Tools-System](Tools-System.md) 详述。

> 📌 深入：`FuturesOrdered` 来自 `futures` crate，保证 future **按完成顺序**产出，不是按启动顺序。这样模型发出的多个并行工具调用，先完成的先拿回结果。

---

## 6. 工具调用在循环中的位置（一句话回顾）

```
run_turn loop
  └─ run_sampling_request
       └─ try_run_sampling_request
            └─ stream.next() 读到 FunctionCall
                 └─ tool_runtime.handle_tool_call(call)      ← 从这里进入 Tools-System
                      └─ ToolRouter.dispatch → ToolRegistry → ToolOrchestrator（审批+沙箱）→ 执行
            └─ 工具结果进 in_flight，完成后变成 ResponseInputItem 写回历史
  └─ 下一轮采样：历史带上工具结果 → 模型看到结果 → 继续决策
```

> 🔗 工具调用的完整链路（注册/路由/审批/沙箱/执行）在 [Tools-System](Tools-System.md)；「模型客户端怎么说话」在 [Model-Client](Model-Client.md)；「世界状态里有什么」在 [Context-and-Compaction](Context-and-Compaction.md)。

---

## 小结

- 三层循环对应三种生命周期：**会话（事件泵）、turn（主循环）、step（一次采样）**。
- `run_turn` 的决策只有四件事：**取输入 → 构建快照 → 采样执行 → 决定继续还是结束**。
- 流式是核心技巧：`FuturesOrdered` 让工具调用与响应流并行；`CancellationToken` 让 Ctrl+C 能贯穿三层。

## 下一步阅读

- 工具怎么被找到、审批、执行 → [Tools-System](Tools-System.md)
- 模型客户端怎么收发 → [Model-Client](Model-Client.md)
- 世界状态与压缩 → [Context-and-Compaction](Context-and-Compaction.md)
