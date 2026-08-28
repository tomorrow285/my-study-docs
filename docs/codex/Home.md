# Codex CLI 源码学习 · 首页

> **TL;DR**：OpenAI Codex CLI 是一个**本地运行的 AI 编码代理**（Rust 实现）。本文档带你从零读懂它：先读「一条主线」建立整体认知，再逐个深挖核心模块，最后用面试题自测。读完你应能回答：**系统在什么事件下、由谁、按什么顺序、经过哪些角色，最后得到什么结果**。

- 源码根目录：`C:\temp_project\codex`（Rust 工作区，138 个 crate）
- 学习定位：**代码实现为主**（模式 A），核心代码会贴出来逐步拆解
- 所有源码路径在本文档中相对 `C:\temp_project\codex` 仓库根；行号为写文档时点的源码位置，随版本可能变化

---

## 一句话：这个项目是做什么的？

> Codex CLI 让你在终端里对 AI 说「帮我改这段代码」「解释这个项目」，AI 会**自己运行命令、查看文件、编辑代码**，直到完成任务。它像 GitHub Copilot 的命令行版，但能真正操作你的电脑（受限地）。

要理解它的源码，只需要抓住一个问题：**一个没有"手"的大语言模型，如何在你的电脑上安全地干活？**

- 它没有手 → 通过**工具调用**（运行 shell 命令、编辑文件）来动手
- 它是 LLM → 所有决策本质上是**一次次的文本采样**
- 它可能犯错 → 每一步都要经过**审批 + 沙箱**约束

---

## 逻辑架构图

```
┌────────────────────────── 用户层 ──────────────────────────┐
│  TUI (codex-rs/tui) ──ratatui 终端界面/事件循环              │
│  CLI (codex-rs/cli)  ──多命令分发器（codex / codex exec）    │
└──────────────────────────────┬─────────────────────────────┘
                               │ app-server 协议
┌──────────────────────────────▼─────────────────────────────┐
│              core (codex-rs/core) —— 一切业务逻辑            │
│                                                             │
│  ThreadManager ──► CodexThread ──► Session ──► 三层循环      │
│  线程生命周期      双向消息导管     运行时状态      ①submission_loop
│                                    │            ②run_turn
│                                    │            ③try_run_sampling
│  ┌──────────────┬──────────────────┼───────────────┬──────────┐
│  ▼              ▼                  ▼               ▼          ▼
│ Tools           Model Client    WorldState      ExecPolicy  Compaction
│ 注册/路由/编排    stream()        上下文快照      Allow/Prompt/Forbidden
│ 审批/沙箱
└──────┬───────────┬──────────────────┬──────────────┬─────────┘
       │           │                  │              │
       ▼           ▼                  ▼              ▼
  sandboxing    model-provider      rollout       config
  跨平台沙箱      模型后端抽象       JSONL会话记录    分层配置
  (Seatbelt/     (OpenAI/ChatGPT/   (thread-store) (layer stack)
   bwrap/Landlock/ OSS/Bedrock)
   Windows)
```

角色分层（先记这四个词，后面全文通用）：

| 角色 | 谁 | 职责 |
|------|----|------|
| **门面** | `CodexThread` / `ThreadManager` | 对外入口：提交 Op、管理线程生命周期 |
| **裁判** | `Session` + 三层循环 | 核心决策者：接收输入、构建上下文、调模型、调度工具 |
| **执行者** | `ToolRuntime` + 沙箱 | 各工具的实际执行（shell/apply_patch/plan…） |
| **审批者** | 用户 UI / Guardian / Hooks | 在危险操作前说「允许/禁止」 |

---

## 一条主线（必读）

下面这条主线回答 skill 的核心三问：**何时被调用、主要工作角色、主线流程**。详细机制都链接到对应主文档，这里只讲串联。

### ① 何时被调用 —— 所有入口点

| 谁调用 | 何时调用 | 调用什么 API | 返回什么 |
|--------|---------|-------------|---------|
| 用户在终端输入 `codex` | 交互模式 | `cli/main.rs → run_interactive_tui()` → `tui::run_main()` | 进入 TUI 事件循环 |
| 用户在终端输入 `codex exec ...` | 非交互一次性任务 | `cli/main.rs → codex_exec::run_main()` | 执行结果 |
| TUI 事件循环 | 新建对话 | `app_server_session::start_thread_with_request_handle()` → `ThreadManager::start_thread()` | `NewThread`（含 `CodexThread`） |
| 用户发消息 | 对话中 | `CodexThread::submit(Op::TurnInput)` | `SubmissionId`（异步） |
| 用户 Ctrl+C | 对话中 | `CodexThread::submit(Op::Interrupt)` | 打断当前 turn |
| 恢复/分支 | `codex resume` / `codex fork` | `ThreadManager::resume_thread_from_rollout()` / `fork_thread()` | `CodexThread` |
| 多 agent | 主 agent 决策 | `spawn_agent` 工具 → `ThreadManager::spawn_subagent()` | 子线程句柄 |

> 初始化时机：`ThreadManager` 在 CLI 启动时创建一次，进程级；`CodexThread` 每新建一个对话创建一次，会话级；`Session` 与 `CodexThread` 一一对应。详见 [Session-and-Thread](Core-Modules/Session-and-Thread.md)。

### ② 主要工作角色

- **门面（你看到的）**：`CodexThread` 是「构成一个 thread 的双向消息流导管」（源码注释，[codex_thread.rs:226](C:\temp_project\codex\codex-rs\core\src\codex_thread.rs#L226)）。你提交的每条消息、每个 Ctrl+C，都变成 `Op` 塞进它的通道。
- **裁判（核心大脑）**：`Session` 内部跑着**三层循环**，这是项目灵魂，见 [Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md)：
  1. `submission_loop` —— 会话事件泵，逐个分发 `Op`（[handlers.rs:514](C:\temp_project\codex\codex-rs\core\src\session\handlers.rs#L514)）
  2. `run_turn` —— 一次 turn 的「采样-执行工具-再采样」主循环（[turn.rs:301](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L301)）
  3. `try_run_sampling_request` —— 流式响应解析 + 工具分发（[turn.rs:2251](C:\temp_project\codex\codex-rs\core\src\session\turn.rs#L2251)）
- **执行者（动手的）**：`ToolRegistry` 里注册的每个 `ToolRuntime`。模型说「我要调 shell」，registry 找到 handler，orchestrator 负责审批+沙箱，见 [Tools-System](Core-Modules/Tools-System.md)。
- **审批者（说"不"的）**：优先级 **Hooks → Guardian（自动审）→ 用户**（[approvals.rs:454-457](C:\temp_project\codex\codex-rs\core\src\tools\approvals.rs#L454-L457) 注释），见 [Execution-Sandbox](Core-Modules/Execution-Sandbox.md)。

### ③ 端到端旅程（一个完整任务怎么走）

以「用户在终端对 Codex 说『给这个仓库加个 README』」为例：

```
用户发起
   │  输入 "给这个仓库加个 README"
   ▼
门面: CodexThread.submit(Op::TurnInput)
   │  提交到 Session 的提交通道
   ▼
裁判 ①: submission_loop 收到 Op::TurnInput
   │  turn_input::handle → spawn_task(RegularTask)
   ▼
裁判 ②: run_turn 进入 loop
   │  (a) 取 pending input
   │  (b) 捕获 step_context（世界状态快照：人格/工具列表/AGENTS.md/历史）
   │  (c) run_sampling_request —— 把上下文发给模型
   ▼
裁判 ③: try_run_sampling_request 逐事件处理流式响应
   │  模型输出工具调用: shell("ls")
   │  tool_runtime.handle_tool_call → Tools-System
   ▼
执行者+审批者: ToolRegistry → ToolOrchestrator
   │  execpolicy 判定 → approval（需要的话）→ 沙箱选择
   │  沙箱内执行 shell("ls")，结果返回模型
   ▼
裁判 ②: 循环继续（结果喂回 → 再采样 → 再工具调用…）
   │  模型最后输出文本消息，needs_follow_up=false
   ▼
裁判: 跑 stop hooks，break 出 run_turn
   │
   ▼
结果: 事件流经 SessionIo 返回给 TUI 渲染给用户
```

> 一句话概括旅程：**用户想做 X → 模型走「采样→工具→再采样」的循环 → 每步工具调用过审批+沙箱三关 → 直到模型给出最终答案**。

---

## 文档导航 & 推荐学习路径

推荐按此顺序读（从外到内、从总到分）：

| 顺序 | 文档 | 你将获得 |
|------|------|---------|
| 1 | [Getting-Started](Getting-Started.md) | 如何构建运行、跑通最小 demo，动手前必备 |
| 2 | [Session-and-Thread](Core-Modules/Session-and-Thread.md) | 门面层：线程/会话/事件泵，理解对象从哪来 |
| 3 | [Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md) | ⭐ 项目灵魂：三层循环的完整拆解 |
| 4 | [Tools-System](Core-Modules/Tools-System.md) | Agent 的"手"：工具注册→路由→审批→执行 |
| 5 | [Execution-Sandbox](Core-Modules/Execution-Sandbox.md) | 安全设计精髓：execpolicy + 审批 + 沙箱 |
| 6 | [Model-Client](Core-Modules/Model-Client.md) | Agent 的"大脑连接"：模型客户端与后端抽象 |
| 7 | [Context-and-Compaction](Core-Modules/Context-and-Compaction.md) | 上下文如何构建、超限如何压缩 |
| 8 | [Rollout](Concepts/Rollout.md) | 会话记录：resume/fork 的数据基础 |
| 9 | [Config-System](Concepts/Config-System.md) | 配置分层加载 |
| 10 | [Skills-and-AgentsMd](Concepts/Skills-and-AgentsMd.md) | 用户如何给 Agent 注入指令 |
| 11 | [Interview-Questions](Interview-Questions.md) | 全部知识点自测 |

> 学习策略：**主线（本页）→ 核心模块 2-7 → 概念 8-10 → 面试题**。时间有限就只读 2-5 + 面试题，这 20% 的代码覆盖了 80% 的项目价值。

---

## 源码布局速查（Codex 的 138 个 crate 怎么分布的）

| 目录（codex-rs/ 下） | 一句话职责 | 学习优先级 |
|----------------------|-----------|-----------|
| `core/` | ⭐ 一切业务逻辑：session/turn/agent/tools/exec/context/compact | **必读** |
| `protocol/` | 共享协议类型：`Op`/`EventMsg`/`ThreadId` | 查字典用 |
| `tools/` | 工具协议与类型（`ToolSpec`/`ToolExecutor`） | 配合 core 读 |
| `tui/` | 交互式终端界面（ratatui） | 外壳，了解即可 |
| `cli/` | 多命令分发器 | 外壳，了解即可 |
| `exec/` | 非交互 `codex exec` 入口 | 外壳，了解即可 |
| `execpolicy/` | execpolicy JSON 策略（Allow/Prompt/Forbidden） | 深写 |
| `sandboxing/` + `linux-sandbox` + `windows-sandbox-rs` | 跨平台沙箱 | 深写 |
| `model-provider/` + `model-provider-info` | 模型后端抽象 | 深写 |
| `codex-api/` | Responses API 的 HTTP/WS 实现 | 中等 |
| `thread-store/` + `rollout/` | 会话持久化 | 中等 |
| `config/` | config.toml 分层加载 | 了解即可 |
| `login/` + `chatgpt/` | 认证（ChatGPT 登录/API key） | 了解即可 |
| 其余 ~120 个 `utils/`、`ext/`、`app-server` 等 | 辅助支撑 | 按需查阅 |

> 核心结论：**138 个 crate 中，真正承载「智能」的只有一个 `core` crate**。其余都是它的配件。这也是为什么这套文档 80% 的篇幅都围绕 `core/`。

---

## 下一步阅读

- 想先动手跑起来 → [Getting-Started](Getting-Started.md)
- 想直接进入灵魂 → [Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md)
- 想先建立对象模型 → [Session-and-Thread](Core-Modules/Session-and-Thread.md)
