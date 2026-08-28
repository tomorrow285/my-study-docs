# 核心模块 · 模型客户端与提供者（Agent 的「大脑连接」）

> **TL;DR**：Codex 通过 `ModelClient`（会话级）+ `ModelClientSession`（turn 级）与模型通信，走 OpenAI **Responses 协议**（WebSocket 优先、HTTP 兜底）。后端用 `ModelProvider` trait 抽象：OpenAI / ChatGPT 登录 / OSS 本地 / AWS Bedrock 只是不同实现。读完你能说出：一次采样请求从 `stream()` 发出到流式返回，通道怎么选、后端怎么解耦。

**对应源码**：`codex-rs/core/src/client.rs`（模型客户端）、`codex-rs/model-provider/src/provider.rs`（后端抽象）、`codex-rs/model-provider-info/`（provider 描述）

> 前置知识：读完 [Agent-Turn-Loop](Agent-Turn-Loop.md)，知道第三层调 `client_session.stream(...)` 拿流。

---

## 0. 两个层级的对象

和 Session 的设计对称，模型客户端也分**会话级**和**turn 级**：

| 对象 | 生命周期 | 职责 |
|------|---------|------|
| `ModelClient`（[client.rs:257](C:\temp_project\codex\codex-rs\core\src\client.rs#L257)） | 整个 session | 持稳定配置：provider、auth、thread_id、transport 回退状态 |
| `ModelClientSession`（[client.rs:277](C:\temp_project\codex\codex-rs\core\src\client.rs#L277)） | 一个 turn | turn 内流式请求；**懒建立 WS 连接并在 turn 内复用**；缓存 `x-codex-turn-state` sticky-routing token |

> 源码注释（[client.rs:1-19](C:\temp_project\codex\codex-rs\core\src\client.rs#L1-L19)）强调：**每个 Codex turn 新建一个 `ModelClientSession`，跨 turn 复用会违反 sticky routing 契约**。这是理解为何分两层的钥匙——sticky routing 要求同一 turn 的请求粘到同一后端节点。

---

## 1. 一次采样的通道选择：stream()

核心入口 `ModelClientSession::stream`（[client.rs:1884](C:\temp_project\codex\codex-rs\core\src\client.rs#L1884)），教学注释 `// ←`：

```rust
pub async fn stream(
    &mut self,
    prompt: &Prompt,
    model_info: &ModelInfo,
    session_telemetry: &SessionTelemetry,
    effort: Option<ReasoningEffortConfig>,
    summary: ReasoningSummaryConfig,
    service_tier: Option<String>,
    responses_metadata: &CodexResponsesMetadata,
    inference_trace: &InferenceTraceContext,
) -> Result<ResponseStream> {
    let wire_api = self.client.state.provider.info().wire_api;   // ← 读后端声明的协议
    match wire_api {
        WireApi::Responses => {                                   // ← 目前只有 Responses
            if self.client.responses_websocket_enabled() {        // ← 若启用 WS
                match self.stream_responses_websocket(...).await? {
                    WebsocketStreamOutcome::Stream(stream) => return Ok(stream),  // ← WS 成功
                    WebsocketStreamOutcome::FallbackToHttp => {
                        // WS 挂了 → 永久切 HTTP（本 session 内）
                        self.try_switch_fallback_transport(session_telemetry, model_info);
                    }
                }
            }
            self.stream_responses_api(...).await                  // ← HTTP 兜底
        }
    }
}
```

**教学解读**：
- **`WireApi` 是全局开关**：`provider.info().wire_api` 决定走什么协议。当前只有 `WireApi::Responses`（旧的 `chat` wire 已被移除，见 [model-provider-info/src/lib.rs:57](C:\temp_project\codex\codex-rs\model-provider-info\src\lib.rs#L57) 的 `CHAT_WIRE_API_REMOVED_ERROR`）。
- **WS 优先，HTTP 兜底**：优先走 WebSocket 通道（低延迟、可复用），失败则 `try_switch_fallback_transport` 永久切 HTTP——注意是**永久**（`force_http_fallback`），避免反复横跳。
- 这个 `match wire_api` 就是「多后端」的汇聚点：将来加新协议，只需要在这里加分支。

> 📌 深入：为什么用 WS？源码注释（[client.rs:281-291](C:\temp_project\codex\codex-rs\core\src\client.rs#L281-L291)）说 `ModelClientSession` 懒建立 Responses WebSocket 连接，且 turn 内的多个 `response.create` 请求复用同一连接和 `previous_response_id`——这就是流式多步对话能保持状态的原因。WS 预暖（prewarm）是 v2-only 的 `response.create` + `generate=false`，提前把连接和 `previous_response_id` 备好，后续请求直接复用。

---

## 2. 后端抽象：ModelProvider trait

`model-provider` crate 定义了核心 trait `ModelProvider`（[provider.rs:141](C:\temp_project\codex\codex-rs\model-provider\src\provider.rs#L141)），方法一览：

```rust
pub trait ModelProvider {
    fn info(&self) -> &ModelProviderInfo;          // ← provider 身份（name/base_url/wire_api）
    fn capabilities(&self) -> ProviderCapabilities; // ← 能力（远端压缩支持等）
    fn auth_manager(&self) -> Option<Arc<AuthManager>>;   // ← 认证
    fn auth(&self) -> ...;                          // ← 取当前认证
    fn account_state(&self) -> ...;                 // ← 账号状态
    fn api_provider(&self) -> ...;                  // ← 底层 HTTP/WS provider
    fn models_manager(&self) -> ...;                // ← 模型目录
}
```

**工厂函数** `create_model_provider`（[provider.rs:308](C:\temp_project\codex\codex-rs\model-provider\src\provider.rs#L308)）——项目里「策略模式」的教科书写法：

```rust
pub fn create_model_provider(
    provider_info: ModelProviderInfo,
    auth_manager: Option<Arc<AuthManager>>,
) -> SharedModelProvider {
    if provider_info.is_amazon_bedrock() {
        Arc::new(AmazonBedrockModelProvider::new(provider_info, auth_manager))  // ← AWS 特化
    } else {
        Arc::new(ConfiguredModelProvider::new(provider_info, auth_manager))     // ← 通用
    }
}
```

`ConfiguredModelProvider`（[provider.rs:321](C:\temp_project\codex\codex-rs\model-provider\src\provider.rs#L321)）是**通用后端**：所有配置化的 provider（OpenAI、ChatGPT、OSS 本地模型）都走它，差异全部体现在 `ModelProviderInfo` 上。

`capabilities()` 演示了能力差异如何抽象（[provider.rs:341-354](C:\temp_project\codex\codex-rs\model-provider\src\provider.rs#L341-L354)）：

```rust
fn capabilities(&self) -> ProviderCapabilities {
    let remote_compaction = if self.info.is_openai()
        || is_azure_responses_provider(&self.info.name, self.info.base_url.as_deref())
    { RemoteCompactionSupport::V2 } else { RemoteCompactionSupport::Unsupported };
    ProviderCapabilities { remote_compaction, ..Default::default() }
}
```

---

## 3. Provider 全家福

| Provider | 实现 | 何时用 |
|----------|------|--------|
| OpenAI Responses | `ConfiguredModelProvider` + `codex-api` | 默认（API key / ChatGPT 登录） |
| ChatGPT 登录 | `chatgpt` crate + `login::AuthManager` | `codex` 选 Sign in with ChatGPT |
| OSS 本地 | `model-provider-info::create_oss_provider` | 配置 `model_provider` 指向本地 |
| LM Studio / Ollama | `lmstudio` / `ollama` crate | 本地模型 |
| AWS Bedrock | `AmazonBedrockModelProvider` | `is_amazon_bedrock()` |
| Azure | `is_azure_responses_provider` 判断 | 配置 base_url |

> 💡 **理解要点**：`ModelProviderInfo` 是一张「名片」——name、base_url、`wire_api`、auth 方式、环境变量 key。它让**一份 core 代码支持所有后端**。想接新模型 = 填一张名片，不用改 core。

---

## 4. 认证：两种模式的差异（影响上层行为）

`ConfiguredModelProvider` 的一些方法按**认证方式**分支（[provider.rs:356-378](C:\temp_project\codex\codex-rs\model-provider\src\provider.rs#L356-L378)）：

```rust
fn approval_review_preferred_model(&self) -> &'static str {
    // API key 认证 → 用更便宜的审阅模型；ChatGPT 认证 → 用默认
    if auth.is_api_key_auth() { API_KEY_APPROVAL_REVIEW_PREFERRED_MODEL } else { DEFAULT_... }
}
fn supports_attestation(&self) -> bool {
    // 只有 ChatGPT 登录支持 attestation（防中间人）
    self.auth_manager.auth_cached().is_some_and(|auth| auth.is_chatgpt_auth())
}
```

| 能力 | API key | ChatGPT 登录 |
|------|---------|--------------|
| 审阅用模型 | 便宜档 | 默认档 |
| Attestation | 不支持 | 支持 |

> 这解释了为什么认证方式会**上溯影响**工具审批（Guardian 审阅模型的选型）——抽象无处不在。

---

## 5. 常见误区

- ❌ 误以为 `ModelClient` 每次请求新建：它是**会话级**的，`ModelClientSession` 才是 turn 级的。
- ❌ 误以为只有 HTTP：**WS 是主通道**，HTTP 是 fallback，且 fallback 是一次性切换。
- ❌ 误以为加新模型要改 core：只要 provider 支持 Responses wire 协议，**配置一张 `ModelProviderInfo` 名片**就够了。

---

## 小结

- **两级客户端**：`ModelClient`（会话）+ `ModelClientSession`（turn，WS 复用 + sticky routing）。
- **通道选择**：`stream()` 按 `wire_api` 分发，WS 优先、HTTP 永久兜底。
- **后端抽象**：`ModelProvider` trait + `create_model_provider` 工厂；Bedrock 特化、其余走 `ConfiguredModelProvider`。
- **名片机制**：`ModelProviderInfo` 让多后端零侵入扩展。

## 下一步阅读

- 发给模型的 Prompt 和世界状态怎么构建 → [Context-and-Compaction](Context-and-Compaction.md)
- 认证/登录细节 → 直接读 `codex-rs/login/`
- 真正的协议实现（HTTP/WS） → `codex-rs/codex-api/`
