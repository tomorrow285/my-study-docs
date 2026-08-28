# Codex 源码面试题与答案

> 建议学习完全部文档后，**先尝试独立作答，再对照答案检查**。如果某题答不上来，回到对应文档章节重新阅读，而不是直接背答案。

**题库覆盖**：会话与线程（5 题）· Agent 三层循环（5 题）· 工具系统（5 题）· 执行与安全（5 题）· 模型客户端（4 题）· 上下文与压缩（4 题）· 概念（3 题）· 综合设计（3 题）

---

## 一、会话与线程模型

## Q1: Codex 中 Thread / Session / CodexThread / SessionIo 四个对象各自职责是什么？

**难度**：入门
**对应文档**：[Session-and-Thread](Core-Modules/Session-and-Thread.md)

**答案**：

| 对象 | 职责 |
|------|------|
| `ThreadManager` | 所有会话的注册表 + 工厂：建线程、恢复、fork、spawn 子 agent |
| `CodexThread` | 一个会话的对外门面（双向消息导管），`submit(op)` 提交操作 |
| `Session` | 内部运行时：状态、三层循环、工具/模型/审批都在这里 |
| `SessionIo` | 消息通道对：`tx_sub`（提交 Op）+ `rx_event`（事件接收）+ 状态 watch |

类比：ThreadManager=酒店前台，CodexThread=房卡，Session=房间设施，SessionIo=对讲机。证据：[codex_thread.rs:226](C:\temp_project\codex\codex-rs\core\src\codex_thread.rs#L226) 注释「Conduit for the bidirectional stream of messages」。

---

## Q2: 为什么需要 ThreadManager 而不是一个全局 Session？

**难度**：进阶
**对应文档**：[Session-and-Thread](Core-Modules/Session-and-Thread.md)

**答案**：

因为 Codex 是**多线程（多 agent）**系统：主 agent 可以通过 `spawn_agent` 工具产生**子 agent**，子 agent 是独立的 thread，有自己的 Session。ThreadManager 用 `HashMap<ThreadId, Arc<CodexThread>>` 索引所有线程，统一管理生命周期。它还承担恢复（`resume_thread_from_rollout`）和分支（`fork_thread`）职责。若只有一个全局 Session，就无法支持多 agent 协作与隔离。

---

## Q3: Thread / Turn / Step / Op 的层级关系是什么？

**难度**：入门
**对应文档**：[Session-and-Thread](Core-Modules/Session-and-Thread.md)

**答案**：

- **Thread**（线程/对话）= 一次完整对话，跨多个 Turn，持久化在 rollout。
- **Turn**（回合）= 一次「用户输入 → Agent 干完 → 停下」的响应周期，有 `sub_id`。
- **Step**（步骤）= 一次采样请求 + 该次触发的一批工具调用；一个 Turn 含多个 Step。
- **Op**（操作）= 提交给 Session 的最小指令单元（TurnInput/Interrupt/Shutdown）。

记忆：**Thread ⊃ Turn ⊃ Step**，Op 是驱动这一切的消息。一个 Session 同时最多一个 active turn（[session/session.rs:39](C:\temp_project\codex\codex-rs\core\src\session\session.rs#L39) 注释）。

---

## Q4: submission_loop 靠什么退出循环？

**难度**：入门
**对应文档**：[Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md#2-第-1-层submission_loop--会话事件泵)

**答案**：

`submission_loop` 的 `while let Ok(sub) = rx_sub.recv().await` 循环里，每个 Op 处理完返回 `should_exit: bool`，绝大多数是 `false`。只有两种让循环退出：
1. `Op::Shutdown` → `true`；
2. `Op::SuspendTurnAndShutdown` 且**历史已持久化成功**（`SuspendTurnOutcome::Suspended`）→ `true`。

源码注释明确「To break out of this loop, send Op::Shutdown」（[handlers.rs:519](C:\temp_project\codex\codex-rs\core\src\session\handlers.rs#L519)）。

---

## Q5: 用户在 Agent 运行中发新消息，Codex 如何响应？

**难度**：进阶
**对应文档**：[Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md#3-进入-turnturn_input-的三种启动模式)

**答案**：

`Op::TurnInput` 带一个 `mode: TurnInputMode`，三种策略（[turn_input.rs:140](C:\temp_project\codex\codex-rs\core\src\session\turn_input.rs#L140)）：
- `StartOrSteer`：有活跃 turn 就**转向**（`steer_input`），没有就新开；
- `StartIfIdle`：只在空闲时新开（自动恢复/后台任务）；
- `Steer { expected_turn_id }`：必须转向指定 turn（UI 明确指向）。

转向时消息并入当前 turn 的 pending_input；新开时 `spawn_task` 起一个 `RegularTask`。turn 循环里 `can_drain_pending_input` 门控决定是否接受运行期间的新输入。

---

## 二、Agent 三层循环

## Q6: 描述 Codex 的三层循环及各自职责。

**难度**：入门
**对应文档**：[Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md#1-三层循环总览)

**答案**：

| 层 | 生命周期 | 核心函数 | 职责 |
|----|---------|---------|------|
| 1 | 会话常驻 | `submission_loop`（[handlers.rs:514](C:\temp_project\codex\codex-rs\core\src\session\handlers.rs#L514)） | 事件泵：接收所有 Op |
| 2 | 一次 turn | `run_turn`（[turn.rs:153](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L153)，主循环 :301） | 采样-执行工具-再采样 |
| 3 | 一次采样 | `try_run_sampling_request`（[turn.rs:2180](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L2180)） | 流式响应解析 + 工具分发 |

---

## Q7: run_turn 的主循环里，哪些条件触发 continue？哪些触发 break？

**难度**：进阶
**对应文档**：[Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md#4-第-2-层run_turn--turn-主循环深写)

**答案**：

- **continue**（继续下一轮采样）：
  1. 还有 pending 输入（`has_pending_input`）；
  2. token 预判超限 → `run_auto_compact` 压缩后 continue；
  3. 模型 `needs_follow_up` 且有新上下文窗口请求。
- **break**（结束 turn）：
  1. `run_hooks_and_record_inputs` 返回 true；
  2. 无 pending 输入、无 token 问题、不需要 follow-up → 跑 stop hooks 后 break；
  3. 采样返回 `TurnAborted`（Ctrl+C）。

证据：[turn.rs:300-419](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L300-L419)。

---

## Q8: 为什么一个 turn 会有多个 step？StepContext 为什么每次采样重建？

**难度**：进阶
**对应文档**：[Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md#4-第-2-层run_turn--turn-主循环深写) + [Context-and-Compaction](Core-Modules/Context-and-Compaction.md)

**答案**：

LLM 一次采样可能只是要调用工具而非给最终答案。必须把工具结果喂回去再采样，直到模型满意——所以一个 turn 内会反复「采样→工具→再采样」，每次采样是一个 step。

StepContext 每次重建是因为**工具集是上下文相关的**：每次采样前的可用工具（MCP 服务器、动态工具、环境）可能不同。源码强调「同一个 step 的上下文、广告的工具、工具调用必须来自同一份快照」（[turn.rs:333-335](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L333-L335) 注释），避免三者不一致。

---

## Q9: 用户 Ctrl+C 如何贯穿三层循环生效？

**难度**：深入
**对应文档**：[Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md#5-第-3-层try_run_sampling_request--流式处理与工具分发)

**答案**：

核心是 **CancellationToken** 贯穿：
- 第 3 层 `try_run_sampling_request` 的 `stream.next().or_cancel(&cancellation_token)`——等待流事件时被取消，返回 `CancelErr::Cancelled`，break 成 `CodexErr::TurnAborted`；
- 第 2 层 `run_turn` 收到 `TurnAborted` → break；
- 第 1 层 `submission_loop` 此时不会收到新的 Op（因为 turn 任务已结束），会话回到空闲。

`or_cancel` 来自 `async-utils` crate（`OrCancelExt`）。注意：正在执行的工具 future 也要能取消，工具侧有自己的取消令牌。

---

## Q10: try_run_sampling_request 里的 in_flight: FuturesOrdered 是干什么的？

**难度**：深入
**对应文档**：[Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md#5-第-3-层try_run_sampling_request--流式处理与工具分发)

**答案**：

`in_flight: FuturesOrdered<BoxFuture<...>>` 是**并发执行中的工具调用队列**。模型流式输出多个工具调用时，`handle_tool_call` 立刻把每个调用变成 future 塞进去，**边读流边跑工具**——这是流式 agent 与同步 agent 的核心差异。

`FuturesOrdered` 保证**按完成顺序**产出（谁先完成谁先出），而不是按启动顺序。这样模型发起的多个并行工具，先完成的先拿回结果写回历史。

---

## 三、工具系统

## Q11: 描述一个工具从注册到执行的五个环节。

**难度**：入门
**对应文档**：[Tools-System](Core-Modules/Tools-System.md#0-一条主线工具的生命周期)

**答案**：

**注册 → 发现 → 调用 → 审批 → 执行**：
1. **注册**：`spec_plan.rs::build_tool_router`（:117）建 `ToolRegistry`，`add_core_tool_sources` 加内置工具，再加 MCP/扩展/动态工具；
2. **发现**：`build_model_visible_specs` 生成 `ToolSpec` 列表，随采样请求发给模型；
3. **调用**：模型输出 FunctionCall → `router.rs::build_tool_call`（:148）转 `ToolCall`；
4. **审批+沙箱**：`orchestrator.rs::ToolOrchestrator::run`（:125）；
5. **执行**：`registry.rs::dispatch_any_with_terminal_outcome`（:479）→ `tool.handle(invocation)`。

---

## Q12: 为什么 ToolRegistry 每个 step 重建而不是全局一份？

**难度**：进阶
**对应文档**：[Tools-System](Core-Modules/Tools-System.md#①-注册每个-step-建一个新的-registry)

**答案**：

因为**可用工具是上下文相关的**：不同 step 的 MCP 服务器状态、动态工具、环境选择可能不同。每个 step 在 `build_tool_router` 里重新组装 registry，保证模型「看到什么工具」和「实际能调什么工具」一致。这呼应了 StepContext 每次重建的设计哲学——**一次采样 = 一份一致的工具视图**。

---

## Q13: 描述 ToolOrchestrator::run 的「审批 + 沙箱 + 重试」流程。

**难度**：进阶
**对应文档**：[Tools-System](Core-Modules/Tools-System.md#④-审批--沙箱--重试深写)

**答案**：

1. **审批**：根据 `exec_approval_requirement` 三态——`Skip`（放行）、`Forbidden`（直接拒绝）、`NeedsApproval`（调 `session.request_approval`）。审批者优先级：Hooks → Guardian（自动审）→ 用户；
2. **首次沙箱尝试**：`select_initial` 选沙箱类型，在沙箱内执行；
3. **二次尝试**：若被沙箱拦截（如命令想写工作区外），`orchestrator.rs:486-519` 提示「retry without sandbox?」并走升级审批/绕过沙箱。

`AskForApproval::Never` 模式不会无沙箱重试（:369-390）。

---

## Q14: 工具「找不到」和「参数不匹配」的错误处理有何不同？为什么？

**难度**：深入
**对应文档**：[Tools-System](Core-Modules/Tools-System.md#⑤-执行dispatch-到真正的-handler)

**答案**：

在 `dispatch_any_with_terminal_outcome`（[registry.rs:479](C:\temp_project\codex\codex-rs\core\src\tools\registry.rs#L479)）：
- **找不到工具** → 返回 `FunctionCallError::RespondToModel`：**非致命**，让模型换个工具/说法重试；
- **找到但参数不匹配** → 返回 `FunctionCallError::Fatal`：**致命**，因为这是代码 bug 或模型幻觉。

设计原因：模型偶尔「记错」工具名是正常情况，应该优雅重试；但参数类型不匹配说明系统内声明与实际实现不一致，属内部错误，不应默默吞掉。

---

## Q15: parallel_execution 用 RwLock 如何实现工具并行控制？

**难度**：深入
**对应文档**：[Tools-System](Core-Modules/Tools-System.md#并行门控toolcallruntime-的关键设计)

**答案**：

`ToolCallRuntime` 持有 `parallel_execution: Arc<RwLock<()>>`，一个读写锁充当并行门（[parallel.rs:152-156](C:\temp_project\codex\codex-rs\core\src\tools\parallel.rs#L152-L156)）：
- **支持并行的工具**（如多个 sleep、只读命令）→ 拿**读锁**，多个可并发持有；
- **不支持并行的工具**（如修改同一文件的工具）→ 拿**写锁**，全局互斥。

`RwLock<()>` 天然「多读单写」，用最少的代码实现了工具级并行/串行控制。

---

## 四、执行与安全

## Q16: Codex 约束 Agent 执行命令的三层防线是什么？

**难度**：入门
**对应文档**：[Execution-Sandbox](Core-Modules/Execution-Sandbox.md#0-一条命令的三层防线)

**答案**：

1. **execpolicy（策略判定）**：`create_exec_approval_requirement_for_command`（[exec_policy.rs:311](C:\temp_project\codex\codex-rs\core\src\exec_policy.rs#L311)）对命令段做前缀/真实路径匹配，输出 Allow/Prompt/Forbidden；
2. **审批（approval）**：`ToolOrchestrator::run` 中，Forbidden 直接拒，NeedsApproval 走 Hooks → Guardian → 用户；
3. **沙箱（进程隔离）**：`spawn_process`（[spawn.rs:42](C:\temp_project\codex\codex-rs\sandboxing\src\spawn.rs#L42)）以受限方式起进程（Seatbelt/bwrap/Landlock/Windows 受限令牌）。

设计权衡：**沙箱越强，需要的人工审批越少**——纵深防御，任一层都不绝对可信。

---

## Q17: execpolicy 的 Decision 三态如何映射到 ExecApprovalRequirement？

**难度**：进阶
**对应文档**：[Execution-Sandbox](Core-Modules/Execution-Sandbox.md#深写判定入口create_exec_approval_requirement_for_command)

**答案**：

（[exec_policy.rs:375-440](C:\temp_project\codex\codex-rs\core\src\exec_policy.rs#L375-L440)）

| Decision | ExecApprovalRequirement | 备注 |
|----------|------------------------|------|
| `Forbidden` | `Forbidden { reason }` | 直接拒绝 |
| `Prompt` | `NeedsApproval` 或 `Forbidden` | 若 `approval_policy="never"` 则拒绝 |
| `Allow` | `Skip { bypass_sandbox }` | 只有所有命令段都显式 allow 才绕过沙箱 |

`Decision` 定义在 execpolicy crate（[decision.rs:9-16](C:\temp_project\codex\codex-rs\execpolicy\src\decision.rs#L9-L16)），注释含「Prompt 在 never 模式下会被直接拒绝」。

---

## Q18: 为什么命令要拆成多个命令段逐一判定？举例说明。

**难度**：深入
**对应文档**：[Execution-Sandbox](Core-Modules/Execution-Sandbox.md#深写判定入口create_exec_approval_requirement_for_command)

**答案**：

因为 shell 命令可能**嵌套执行**，整体判定会被绕过。`commands_for_exec_policy` 把 `echo a | rm -rf /` 拆成多个命令段逐段判定，避免「`echo` 被 allow 就放行了整条管道」。

另外还有命令替换（`git commit -m "$(rm -rf /)"`）这类嵌套，需要 shell 解析器识别。`Decision::Allow` 时 `bypass_sandbox` 要求**所有段**都被显式 allow（[exec_policy.rs:419-433](C:\temp_project\codex\codex-rs\core\src\exec_policy.rs#L419-L433)）——这就是「策略放行 ≠ 无条件放行」的原因。

---

## Q19: Decision::Allow 时 bypass_sandbox 一定为 true 吗？

**难度**：进阶
**对应文档**：[Execution-Sandbox](Core-Modules/Execution-Sandbox.md#关键坑--备注)

**答案**：

**不一定**。`bypass_sandbox` 只有当 `commands.iter().all(...)` 每个命令段都被策略显式 `Allow` 才为 true（[exec_policy.rs:422-433](C:\temp_project\codex\codex-rs\core\src\exec_policy.rs#L422-L433)）。如果管道中某段没被显式 allow（例如走了 heuristics fallback），则即使整体决策是 Allow，也**不绕过沙箱**——命令照常运行，但仍在沙箱内受约束。这是「策略管能不能跑，沙箱管能碰到什么」的纵深体现。

---

## Q20: 各平台沙箱机制分别是什么？Linux 的 WSL 情况如何？

**难度**：进阶
**对应文档**：[Execution-Sandbox](Core-Modules/Execution-Sandbox.md#第-3-关沙箱--进程隔离)

**答案**：

| 平台 | 机制 |
|------|------|
| macOS | **Seatbelt**（`/usr/bin/sandbox-exec` + profile），[seatbelt.rs](C:\temp_project\codex\codex-rs\sandboxing\src\seatbelt.rs) |
| Linux | **bubblewrap**（需 user namespace）或 **Landlock**（无需 root） |
| Windows | **受限令牌 + 私有桌面**（`spawn_windows_sandbox_session_for_level`） |

平台选择在 `get_platform_sandbox`（[manager.rs:62](C:\temp_project\codex\codex-rs\sandboxing\src\manager.rs#L62)）。WSL2 走 Linux bubblewrap；**WSL1 不支持**（无法创建 user namespace，直接拒绝沙箱命令）。bwrap 缺失时用仓库自带 `codex-resources/bwrap` 并弹启动警告（来源：[core/README.md](C:\temp_project\codex\codex-rs\core\README.md)）。

---

## 五、模型客户端

## Q21: ModelClient 和 ModelClientSession 的区别？为什么分两级？

**难度**：进阶
**对应文档**：[Model-Client](Core-Modules/Model-Client.md#0-两个层级的对象)

**答案**：

- `ModelClient`：**会话级**，持稳定配置（provider、auth、thread_id、transport 回退状态），整个 session 一个。
- `ModelClientSession`：**turn 级**，turn 内流式请求，**懒建立 WS 连接并在 turn 内复用**，缓存 `x-codex-turn-state` sticky-routing token。

源码注释强调：**每个 turn 新建 ModelClientSession，跨 turn 复用会违反 sticky routing 契约**（[client.rs:1-19](C:\temp_project\codex\codex-rs\core\src\client.rs#L1-L19)）。sticky routing 要求同一 turn 的请求粘到同一后端节点，所以连接状态是 turn 级。

---

## Q22: stream() 如何选择传输通道？失败时如何兜底？

**难度**：进阶
**对应文档**：[Model-Client](Core-Modules/Model-Client.md#1-一次采样的通道选择stream)

**答案**：

`ModelClientSession::stream`（[client.rs:1884](C:\temp_project\codex\codex-rs\core\src\client.rs#L1884)）：
1. 读 `provider.info().wire_api`，当前只有 `WireApi::Responses`；
2. 若 `responses_websocket_enabled()`，优先 `stream_responses_websocket`；
3. WS 返回 `FallbackToHttp` → `try_switch_fallback_transport` **永久**切 HTTP（`force_http_fallback`），避免反复横跳；
4. HTTP 兜底 `stream_responses_api`。

`match wire_api` 就是多后端的汇聚点——加新协议只需加分支。

---

## Q23: ModelProvider trait 和 create_model_provider 工厂如何解耦多后端？

**难度**：进阶
**对应文档**：[Model-Client](Core-Modules/Model-Client.md#2-后端抽象modelprovider-trait)

**答案**：

`ModelProvider` trait（[provider.rs:141](C:\temp_project\codex\codex-rs\model-provider\src\provider.rs#L141)）定义统一接口：`info()`、`capabilities()`、`auth_manager()`、`auth()`、`account_state()`、`api_provider()`、`models_manager()`。

`create_model_provider`（[provider.rs:308](C:\temp_project\codex\codex-rs\model-provider\src\provider.rs#L308)）是**策略模式工厂**：`is_amazon_bedrock()` → `AmazonBedrockModelProvider`，否则 → `ConfiguredModelProvider`。通用后端 `ConfiguredModelProvider` 让差异全部体现在 `ModelProviderInfo` 名片上（name/base_url/wire_api/auth）。**接新模型 = 填名片，不改 core**。

---

## Q24: 如果我要支持一个新的模型后端（假设它兼容 Responses 协议），需要改哪些地方？

**难度**：深入
**对应文档**：[Model-Client](Core-Modules/Model-Client.md#3-provider-全家福) + [Config-System](Concepts/Config-System.md)

**答案**：

理论上**只需要配置**，不用改代码：
1. 在配置里定义 `ModelProviderInfo`（name、base_url、wire_api=Responses、认证方式）；
2. 若需要能力差异（如远端压缩），在 `ConfiguredModelProvider::capabilities()` 里按 provider 判断。

参考 `lmstudio` / `ollama` / OSS provider 的做法（`model-provider-info::create_oss_provider`）。只有协议不同（如 Bedrock 的特化认证）才需要新写一个 Provider 实现。这就是「名片机制」的威力。

---

## 六、上下文与压缩

## Q25: StepContext 和 WorldState 有什么区别？

**难度**：入门
**对应文档**：[Context-and-Compaction](Core-Modules/Context-and-Compaction.md#0-两个容易混的概念)

**答案**：

- `StepContext`（[step_context.rs:18](C:\temp_project\codex\codex-rs\core\src\step_context.rs#L18)）：**关于这次请求的元数据**——model_info、审批策略、`tool_router`、loaded_agents_md 等。
- `WorldState`（[context/world_state/mod.rs](C:\temp_project\codex\codex-rs\core\src\context\world_state\mod.rs)）：**喂给模型的正文**——人格、工具列表、AGENTS.md 渲染成的文本片段。

记忆：StepContext 装着「怎么调工具」，WorldState 装着「告诉模型你能用什么」。StepContext 由 `capture_step_context` 创建，WorldState 由 `build_world_state_for_step` 构建。

---

## Q26: WorldState 为什么设计成「分段容器」？

**难度**：进阶
**对应文档**：[Context-and-Compaction](Core-Modules/Context-and-Compaction.md#1-世界状态怎么构建)

**答案**：

`WorldState::add_section(...)` 接受 `ModelInstructionsState` / `PersonalityState` / `ToolsState` / `AgentsMdState` / `EnvironmentsState` 等**独立的状态段**。设计动机：
1. **组合式构建**：不同模型/特性组合注入不同内容，`features.enabled(...)` 开关决定段是否加入；
2. **独立演进**：各段独立维护，加新段不影响旧段；
3. **只重建变化**：turn 循环里 `record_step_world_state_if_changed` 只在变化时重算（[turn.rs:365](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L365)）。

---

## Q27: Compaction 的触发条件有哪些？如何保证不陷入死循环？

**难度**：进阶
**对应文档**：[Context-and-Compaction](Core-Modules/Context-and-Compaction.md#3-compaction上下文太长怎么办深写)

**答案**：

触发条件三个：
1. `token_limit_reached`（token 预判超限）；
2. `take_new_context_window_request`（请求换新上下文窗口）；
3. 用户手动 `/compact`。

防死循环设计（[turn.rs:469](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L469) 注释）：**只要压缩能把 token 降到远低于上限，就不会无限循环**。压缩前用 `compact_token_budget.rs` / `context_window.rs` 计算预算，压缩结果必须远低于上限，保证「压缩→继续→再压缩」收敛。

---

## Q28: 本地压缩和远端压缩如何选择？

**难度**：深入
**对应文档**：[Context-and-Compaction](Core-Modules/Context-and-Compaction.md#3-compaction上下文太长怎么办深写) + [Model-Client](Core-Modules/Model-Client.md)

**答案**：

由 `ModelProvider::capabilities().remote_compaction` 决定（[provider.rs:341-354](C:\temp_project\codex\codex-rs\model-provider\src\provider.rs#L341-L354)）：
- OpenAI / Azure Responses provider → `RemoteCompactionSupport::V2`（远端压缩）；
- 其他 provider → `Unsupported`（走本地压缩，`compact.rs` 用本会话模型直接摘要）。

远端压缩的文件是 `compact_remote*.rs` 系列（V2、attempt、images、budget 等）。这个能力差异被抽象进 ProviderCapabilities，core 无需为每个后端写分支。

---

## 七、概念

## Q29: rollout 是什么？resume 和 fork 分别怎么用它？

**难度**：入门
**对应文档**：[Rollout](Concepts/Rollout.md)

**答案**：

rollout 是**只追加的 JSONL 会话事件日志**，每个事件一行 JSON，存在 `~/.codex/sessions/rollout-<时间戳>-<uuid>.jsonl`。`RolloutRecorder`（[recorder.rs:86](C:\temp_project\codex\codex-rs\rollout\src\recorder.rs)）负责写入：`persist` 入队、`flush` 落盘。

- `codex resume` → `ThreadManager::resume_thread_from_rollout` 读 rollout 重建历史续聊；
- `codex fork` → `ThreadManager::fork_thread` 从 rollout 复制历史开新线程。

它是「AI 的记忆文件」，也是调试会话的审计日志。

---

## Q30: Codex 配置分层的优先级是怎样的？

**难度**：入门
**对应文档**：[Config-System](Concepts/Config-System.md)

**答案**：

按 `ConfigLayerSource::precedence()`（[config_layer_source.rs:33](C:\temp_project\codex\codex-rs\config\src\config_layer_source.rs#L33)），**数值大者覆盖小者**：

```
PackagedDefaults(-10) < Mdm(0) < System(10) < Enterprise(15) < User(20/21) < Project(25) < SessionFlags(30) < Legacy(40/50)
```

所以项目 `.codex/config.toml`（25）覆盖用户 `~/.codex/config.toml`（20），命令行 `-c key=value`（SessionFlags, 30）覆盖一切文件配置。

---

## Q31: AGENTS.md 和 Skill 有什么本质区别？

**难度**：进阶
**对应文档**：[Skills-and-AgentsMd](Concepts/Skills-and-AgentsMd.md)

**答案**：

- **AGENTS.md**：**全量常驻**的仓库说明，作用域=所在目录树，会话开始时加载，进 `AgentsMdState` 段。加载有保护：不信任项目不加载、大小预算、沙箱内读取（[agents_md.rs:57](C:\temp_project\codex\codex-rs\core\src\agents_md.rs#L57)）。
- **Skill**：**按需触发**的指令包，通过 `mentions`（用户/模型显式提及 `@skill`）或 `selection`（自动选择）加载，不进常驻上下文。

一句话：**AGENTS.md 默认就在，Skill 要人「叫它」才进**。两者的内容最终都通过 WorldState 注入模型。

---

## 八、综合设计

## Q32: 完整描述「用户输入一条消息到最终答案」的调用链。

**难度**：深入
**对应文档**：[Home](Home.md#③-端到端旅程一个完整任务怎么走)

**答案**：

```
用户输入 → CodexThread.submit(Op::TurnInput)
  → SessionIo.tx_sub → submission_loop (handlers.rs:514)
  → turn_input::handle → start_or_steer → Session::spawn_task
  → RegularTask::run → run_turn (turn.rs:301)
  → loop: 取 pending_input → capture_step_context → run_sampling_request
  → try_run_sampling_request (turn.rs:2180): stream().next() 逐事件
  → 模型输出 FunctionCall → tool_runtime.handle_tool_call
  → ToolRouter.dispatch → ToolRegistry.dispatch → ToolOrchestrator.run（审批+沙箱）
  → 沙箱内执行 → 结果写回历史
  → run_turn 下一轮（历史带上结果再采样）
  → 模型输出最终文本 → needs_follow_up=false → stop hooks → break
  → 事件经 SessionIo.rx_event 返回 TUI 渲染
```

---

## Q33: 如果 Codex 要支持一个全新的工具类型（比如「数据库查询」），需要改哪些地方？

**难度**：深入
**对应文档**：[Tools-System](Core-Modules/Tools-System.md)

**答案**：

按工具系统的五环节设计，主要是**注册**环节：
1. 实现一个 `ToolRuntime`（trait 见 [sandboxing.rs:363](C:\temp_project\codex\codex-rs\core\src\tools\sandboxing.rs#L363)），实现 `handle`（执行）、`exec_approval_requirement`（审批）、`sandbox_permissions`（沙箱需求）等；
2. 在 `add_core_tool_sources`（[spec_plan.rs:888](C:\temp_project\codex\codex-rs\core\src\tools\spec_plan.rs#L888)）里 `registry.add(...)` 注册；
3. 若工具要防御性处理，实现 `pre_tool_use_payload` 接入 hooks；
4. 声明是否支持并行（`supports_parallel_tool_calls`）。

调用、审批、执行环节**无需改动**——它们是通用机制。这正是分层设计（注册/发现/调用/审批/执行解耦）的红利。

---

## Q34: 为什么安全模型是「策略 + 审批 + 沙箱」三层纵深防御，而不是单一强隔离？

**难度**：深入
**对应文档**：[Execution-Sandbox](Core-Modules/Execution-Sandbox.md)

**答案**：

三个理由：
1. **每层解决不同问题**：策略管「**能不能跑**」（权限语义），审批管「**谁同意**」（人机决策），沙箱管「**能碰到什么**」（资源边界）。单一沙箱无法表达「这个命令要人批、那个命令不要」的语义。
2. **单层不可绝对可信**：沙箱有绕过面、策略有覆盖盲区。纵深让突破一层仍有下一层兜底。
3. **UX 与安全的权衡**：沙箱越强，需要人工审批越少（`default_exec_approval_requirement` 依据沙箱策略）。三层可以「策略放行+沙箱内运行」，无需每次都打扰用户——如果只有强隔离，要么每次都要人确认（烦人），要么太弱（危险）。

这就是为什么 `bypass_sandbox` 只在所有命令段都被显式 allow 时才 true：**策略可以放行，但沙箱是最后底线**。
