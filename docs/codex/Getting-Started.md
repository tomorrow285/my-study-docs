# Getting-Started：构建与运行

> **TL;DR**：`cd codex-rs && cargo build` 就能编译出 `codex` 二进制。交互模式 `cargo run --bin codex`，非交互 `cargo run --bin codex -- exec "…"`。读完请继续 [Session-and-Thread](Core-Modules/Session-and-Thread.md)。

源码根：`C:\temp_project\codex`，Rust 工作区在 `codex-rs/`。构建信息来源：[docs/install.md](C:\temp_project\codex\docs\install.md) 与仓库根 [justfile](C:\temp_project\codex\justfile)。

---

## 系统要求

| 要求 | 说明 |
|------|------|
| 操作系统 | macOS 12+，或 Linux（Ubuntu 20.04+/Debian 10+），或 Windows 11 **via WSL2** |
| Rust 工具链 | rustup 安装，另需 `rustfmt`、`clippy` 组件 |
| 辅助工具 | `just`、`dotslash`、`cargo-nextest`（跑测试用） |
| 内存 | 4GB 最低（推荐 8GB） |

> ⚠️ 注意：Windows 原生构建支持有限，官方推荐 WSL2 或 Docker。沙箱在 Windows 上走受限令牌方案（见 [Execution-Sandbox](Core-Modules/Execution-Sandbox.md)）。

---

## 构建

```bash
# 进入 Rust 工作区
cd codex-rs

# 构建整个工作区（会编译 138 个 crate，第一次较久）
cargo build

# 只构建 CLI 二进制
cargo build -p codex-cli
```

仓库根有 `justfile` 提供常用快捷命令（默认工作目录就是 `codex-rs`）：

| just 命令 | 等价操作 | 用途 |
|-----------|---------|------|
| `just codex` | `cargo run --bin codex -- {args}` | 运行 CLI |
| `just exec ...` | `cargo run --bin codex -- exec {args}` | 非交互模式 |
| `just test` | `cargo nextest run` | 跑全部测试 |
| `just test -p codex-tui` | 单 crate 测试 | 快速验证单个 crate |
| `just clippy` | cargo clippy | lint |
| `just fmt` / `just fmt-check` | 格式化 / 检查 | 代码风格 |

---

## 运行：两个模式

Codex 有**交互**和**非交互**两种模式，入口不同（详见 [Session-and-Thread](Core-Modules/Session-and-Thread.md#入口点)）：

### 交互模式（TUI）

```bash
cargo run --bin codex -- "给这个仓库加个 README"
```

- 不带子命令时走 TUI（`tui/` crate），启动后进入对话界面
- 可以直接带一句 prompt，让对话从这句话开始

### 非交互模式（exec）

```bash
cargo run --bin codex -- exec "给这个仓库加个 README" --output-last-message
```

- `exec` 子命令走 `codex_exec::run_main()`（`exec/` crate）
- 适合脚本、CI 里的一次性任务；默认 `RUST_LOG=error`，结果直接打印

---

## 调试与日志

Codex 用 Rust 的 `tracing`，受 `RUST_LOG` 环境变量控制：

```bash
# TUI 模式记录明文日志
codex -c log_dir=./.codex-log
tail -F ./.codex-log/codex-tui.log

# exec 模式调高日志级别
RUST_LOG=debug codex exec "explain this repo"
```

---

## 跑一个最小 demo

想验证「装好了，能跑通」，最直接的方式：

```bash
cd codex-rs
cargo run --bin codex -- exec "输出 hello world 的 Rust 代码"
```

预期看到：模型思考 → 调用 `apply_patch` 或 `shell` 工具 → 输出结果。如果这里能看到工具调用，说明整条链路（TUI 之外）已经通了。想深入理解这条链路内部发生了什么，就是接下来 [Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md) 的内容。

---

## 测试

```bash
just test                    # 全量
just test -p codex-core      # 只测核心逻辑（最相关）
```

> 💡 读代码时遇到不确定的行为，直接搜对应文件的 `*_tests.rs`。测试是行为契约，比注释更可靠。例如 `core/src/session/` 下有 `turn_tests.rs`、`world_state.rs` 有配套测试。

---

## 下一步阅读

- 理解「从命令到对话循环」的对象模型 → [Session-and-Thread](Core-Modules/Session-and-Thread.md)
- 直接进入核心算法 → [Agent-Turn-Loop](Core-Modules/Agent-Turn-Loop.md)
