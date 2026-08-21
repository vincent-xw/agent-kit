# Context Window Indicator & Compression Design

Date: 2026-08-21
Scope: `@agent-kit/core`, `@agent-kit/adapter-sqlite`, `examples/flutter-dev-bff`

## 1. Goal

Add a context-window indicator to the flutter-dev-bff WebUI and automatic/manual context compression so long conversations do not silently hit model token limits.

## 2. Non-Goals

- Exact token counting for every model (we use API `usage` when available, char/4 fallback otherwise).
- Multi-modal token accounting for images/tool attachments.
- Compression strategy configuration exposed to end users.

## 3. Architecture

```
WebUI ──GET /context-status──┐
                              ▼
              ┌─────────────────────────┐
              │   flutter-dev-bff       │
              │  (Context API + UI)     │
              └───────────┬─────────────┘
                          │ inject at harness creation
                          ▼
              ┌─────────────────────────┐
              │   adapter-sqlite        │
              │  createAgentHarness()   │
              └───────────┬─────────────┘
                          │ inject
                          ▼
              ┌─────────────────────────┐
              │   @agent-kit/core       │
              │  LlmClient              │
              │  TokenContextManager    │
              │  tokenCounter           │
              └─────────────────────────┘
```

## 4. Core Changes

### 4.1 `tokenCounter`

New file: `packages/core/src/token-counter.ts`

- `estimateTokens(text: string): number` → `Math.ceil(text.length / 4)`.
- `estimateMessages(messages: SessionMessage[]): number` → sum of estimates.
- `applyUsageCorrection(estimated: number, usage: LlmUsage): number` → return `usage.total_tokens` if available; otherwise `estimated`.

### 4.2 `LlmClient` reads `usage`

File: `packages/core/src/llm-client.ts`

- Parse `response.usage` in `extractResult`.
- Add fields to `LlmTraceEvent`:
  - `promptTokens?: number`
  - `completionTokens?: number`
  - `totalTokens?: number`
- Include token fields in `audit` log events.

### 4.3 Model context limit registry

New file: `packages/core/src/model-context-limits.ts`

- Built-in map for common models (e.g. `deepseek-chat` → 64K, `gpt-4o` → 128K, `claude-3-5-sonnet` → 200K).
- `resolveContextLimit(model: string, envLimit?: string): number` → lookup table, then env, then default 256K.

### 4.4 `TokenContextManager`

New file: `packages/core/src/token-context-manager.ts`

Replaces/extends the existing count-based `ContextManager`. Interface compatible with `createAgentHarness`.

State per session:

- `limit: number`
- `used: number`
- `lastUsage?: LlmUsage`
- `compressedCount: number`
- `highWatermark = 0.8`
- `lowWatermark = 0.5`
- `preserveRecentMessages = 2`

Public methods:

- `onLlmTrace(event: LlmTraceEvent): void` — update `used` with latest `totalTokens` or estimate.
- `prepareMessages(messages: SessionMessage[]): SessionMessage[]` — return messages, compressing if needed.
- `getStatus(): ContextStatus` — returns limit/used/ratio/compressedCount.

## 5. Compression Algorithm

Input: current `messages`, current `used`, thresholds.
Output: compressed `messages`.

1. Skip `system` messages and the most recent `preserveRecentMessages` messages.
2. **Phase 1 — drop tool outputs**: remove all `role === 'tool'` messages outside the protected zone. Recompute `used`. If `used / limit <= lowWatermark`, stop.
3. **Phase 2 — summarize old turns**: take the oldest contiguous block of assistant + tool/user messages outside the protected zone, send them to the main LLM with a summarization prompt, and replace the block with a single `system` message: `Earlier conversation summary: <summary>`.
4. Repeat Phase 2 until `used / limit <= lowWatermark` or only the protected zone remains.

Summarization prompt (Chinese):

> 请把以下对话总结成一段简洁的上下文摘要，保留关键决策、代码改动、错误结论， omit 具体实现细节和重复的工具输出。

## 6. Adapter Changes

File: `packages/adapter-sqlite/src/index.ts`

- `createAgentHarness` accepts an optional `contextManager`.
- When a `TokenContextManager` is provided:
  - Pass it to the harness.
  - Wire `llmTrace` event into `contextManager.onLlmTrace`.
  - Use `contextManager.prepareMessages` before each LLM call.

## 7. BFF Changes

### 7.1 Runtime wiring

File: `examples/flutter-dev-bff/src/server.ts`

- Create one `TokenContextManager` per session or share via session-scoped map.
- Inject it into `createAgentHarness`.
- On every `llmTrace`, forward to the manager.

### 7.2 API endpoints

- `GET /context-status?sessionId=<id>`
  ```json
  {
    "model": "deepseek-chat",
    "limit": 64000,
    "used": 12345,
    "remaining": 51655,
    "ratio": 0.19,
    "compressedCount": 2,
    "lastUpdatedAt": "2026-08-21T14:32:00.000Z"
  }
  ```
- `POST /compact-context?sessionId=<id>` — manually trigger compression, returns same payload.

### 7.3 WebUI

Files: `examples/flutter-dev-bff/public/index.html`, `public/assets/app.js`, `public/assets/app.css`

- Add a `#context-badge` below the input-bar buttons.
- Badge color:
  - green when `ratio < 0.6`
  - yellow when `0.6 <= ratio < 0.8`
  - red when `ratio >= 0.8`
- Badge text shows percentage only, e.g. `19%`.
- Hover/click opens a popover showing:
  - model name + limit
  - used / remaining tokens
  - progress bar
  - compressed count
  - a "压缩上下文" button
- Refresh status after each send and optionally via SSE `context-updated`.

## 8. Error Handling

- Unknown model + no env config: default limit 256K, UI prefix with `~`.
- Summarization API fails: fall back to Phase 1 (drop tool outputs) and return a `summaryFailed` flag in status.
- Manual compact while already at low watermark: return `alreadyCompact` flag.

## 9. Testing Plan

- `packages/core/src/token-counter.test.ts`
  - usage takes precedence over estimate
  - char/4 fallback on Chinese and English text
- `packages/core/src/token-context-manager.test.ts`
  - high watermark triggers compression
  - protected recent messages are preserved
  - compression stops at low watermark
  - manual compact works
- `packages/core/src/llm-client.test.ts`
  - `usage` is parsed and emitted in `LlmTraceEvent`
- `examples/flutter-dev-bff/src/server.test.ts`
  - `/context-status` returns correct shape
  - `/compact-context` reduces `used`

## 10. Migration / Rollout

- `adapter-sqlite` change is backward compatible: no `contextManager` argument keeps existing behavior.
- `.env.example` add:
  ```
  # 模型上下文 token 上限（找不到内置表时生效，默认 256K）
  # LLM_CONTEXT_LIMIT=256000
  # VISION_CONTEXT_LIMIT=256000
  ```
