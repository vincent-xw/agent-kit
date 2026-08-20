# Flutter Dev BFF WebUI：多会话管理 + 时序渲染 + 完整上下文导出 + 亮色主题

日期：2026-08-20
状态：已确认（用户逐节审阅通过）

## 背景与问题

flutter-dev-bff 的 WebUI 存在四组问题，根因如下：

1. **会话串台**：`event-bus.ts` 是全局单例，`tool_start`/`tool_end`/`llm_delta` 事件都不带 sessionId。前端只有一个 EventSource，BFF 输出无差别渲染进当前 DOM。「新建会话」只是换 localStorage ID + 清空 DOM，旧会话还在运行时，输出漏进新会话。
2. **时序错乱 + 内容丢失**：前端每次提问只创建一个 `typingEl`，工具卡片永远 `insertBefore(typingEl)`，所有步骤的 LLM 文本追加进同一个元素；`final` 返回时整体 `innerHTML` 替换，中间已流式渲染的内容被切掉。多轮「工具调用 -> LLM 回复」无法按时间顺序展示。
3. **一键复制上下文残缺**：靠 DOM 拼凑（截断 500 字符）+ 服务端历史（assistant 的 toolCalls 轮 content 为 null、tool 消息 content 是对象，拼不出内容），复制结果本来就不完整，与显示开关无关。
4. **只有暗色主题**：颜色硬编码在 `:root`，无切换。

## 目标

- 多会话管理：左侧边栏，新建/切换/重命名/删除，服务端持久化
- 按时间顺序渲染：用户消息 -> LLM 回复 -> 工具调用 -> LLM 回复 -> ……流式内容零丢失
- 一键复制始终输出完整上下文（Markdown 时序转录，含完整工具输入输出），显示开关只控制 UI 呈现
- 亮色/暗色主题切换，覆盖全部页面（聊天主界面 + 文档页）

## 非目标

- 前端框架化/构建流程（保持原生 HTML/JS/CSS 静态文件）
- 两个标签页同看一个会话时，后开标签页还原正在流式输出轮次的完整历史（已知限制）
- 会话搜索、归档等高级管理功能

## 架构方案（已选：方案 A）

**会话作用域事件 + 按序追加渲染。** 备选方案 B（每步全量重渲染历史）因闪烁与内容丢失被否决；方案 C（AsyncLocalStorage 隐式注入）因隐式耦合、难测试被否决。

核心思路：

- core 契约加可选字段，把 sessionId（和工具的 callId、LLM 的 turnId）随调用链传到事件层
- 前端每会话一个 DOM 容器，事件按到达顺序 append，切换会话只切换容器显示
- `final` 不再整体替换 DOM，只规范化最后一个 turn 元素

## 设计

### core 层（全部为可选字段，纯增量）

| 契约 | 新增字段 | 谁填 |
|---|---|---|
| `ToolExecutionContext` | `sessionId?`, `callId?` | harness 执行服务端工具时传入 |
| `LlmClientRequest` | `sessionId?` | harness 每次 `complete` 时传入 |
| `LlmDelta` | `sessionId?`, `turnId?` | adapter-sqlite 的 llm 包装器：每次 `complete` 生成 `turnId`，闭包附加到该次调用所有 delta |

harness 在 `executeWithTimeout` 处把 `{ signal, sessionId, callId }` 作为 context 传给 `tool.execute`；在 `deps.llm.complete` 请求里带上 `sessionId`。adapter-sqlite 的 complete 包装器在每次调用开头生成 `turnId`（如 `turn-<random>`），包装 `onDelta` 附加 `{ sessionId, turnId }`。

### BFF 层（flutter-dev-bff）

**事件**：`instrumentTools` 从 context 读 `sessionId`/`callId` 写进 `tool_start`/`tool_end` 事件；`llm_delta` 事件由 `llmDelta` 回调展开自然携带 `sessionId`/`turnId`。事件总线与 `/api/events` 端点不变（全量推送，前端按 sessionId 过滤；localhost 单用户，带宽可接受）。

**会话管理 API**（新表 `webui_sessions(session_id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`，与 `agent_sessions` 同库，`CREATE TABLE IF NOT EXISTS` 兼容旧库；`session_id` 存 WebUI 侧原始 id，查 `agent_sessions` 时加 `flutter-dev:` 前缀）：

| 端点 | 行为 |
|---|---|
| `GET /api/sessions` | 列表：id、title、updatedAt，按 updated_at 倒序 |
| `POST /api/sessions` | 创建，服务端生成 id 返回，title 初始为「新会话」 |
| `PATCH /api/sessions/:id` | 重命名；首条消息自动命名也走它（前端首次发送后调用，取首条用户消息前 30 字符） |
| `DELETE /api/sessions/:id` | 删 `webui_sessions` 行 + `agent_sessions` 的 `flutter-dev:<id>` 行 |
| `GET /api/sessions/:id/messages` | 已有，不变；前端开始正确消费 toolCalls/callId/toolName |
| `GET /api/sessions/:id/export?toolOutputLimit=N` | 服务端从完整历史生成 Markdown 时序转录；N 默认 20000，0=全量 |

**导出 Markdown 结构**（时序，示意）：

~~~markdown
# 会话: <标题>

## 用户
<文本>

## 助手
<文本>

## 工具调用: <toolName>
- 输入:
  ```json
  <完整输入 JSON>
  ```
- 输出:
  ```json
  <输出 JSON，按 toolOutputLimit 截断，超出标注「已截断，共 N 字符」>
  ```
~~~

鉴权沿用现有 token 校验；截断在服务端做。

### WebUI 层

**布局与会话管理**

- 左侧固定边栏（约 240px）：顶部「＋ 新建会话」，下方会话列表（标题 + 相对时间），当前会话高亮；hover 显示删除按钮，双击标题就地重命名（调 PATCH）
- 非当前会话收到事件时，边栏该项显示活动圆点（3 秒内有事件即亮），无需额外协议
- 每个会话一个独立消息容器 div，切换 = 显示/隐藏，不销毁 DOM（运行中切走再切回不丢内容的关键）
- 首次打开某会话从 `/api/sessions/:id/messages` 还原：`user` -> 用户消息；`assistant` 文本 -> 助手消息；`assistant.toolCalls` + 后续 `tool` 消息按 `callId` 合并为工具卡片（含输入与输出）；历史还原与实时渲染共用同一套卡片结构

**时序渲染**

唯一规则：事件按到达顺序 append 到容器末尾。

- `llm_delta` 见新 `turnId` -> 容器末尾新建助手消息元素；同一 `turnId` 增量追加进该元素
- `tool_start {callId}` -> 容器末尾追加工具卡片（执行中 + 输入），按 `callId` 索引（修掉同名工具并行调用互相覆盖的 bug：现状 `toolEls` 按工具名做 key）
- `tool_end {callId}` -> 按 `callId` 更新卡片状态与输出
- `final` -> 只规范化最后一个 turn 元素（流式文本即 final 文本），中间 turn 一律不动；空 final 显示占位说明
- SSE 断线重连重放去重：每会话记录已渲染最大 `seq`，重放事件 `seq ≤ 已渲染` 丢弃
- 「显示工具调用详情」开关只切 CSS class（现状机制保留），卡片数据始终完整

**一键复制**

`fetch export 端点`（带设置里的 `toolOutputLimit`）-> clipboard。设置面板新增「复制时工具输出上限」：全量 / 10K / 20K（默认）/ 50K，localStorage 持久化。

**主题**

- 抽公共 `theme.css`：`:root`（暗色，默认）+ `html[data-theme='light']`（亮色）两套 CSS 变量
- index.html 内联样式迁移到 `app.css` 并改用变量；docs.css 同步改用变量
- 设置面板加「亮色/暗色」切换，localStorage `theme` 持久化；每页 `<head>` 内联一段脚本在渲染前设置 `data-theme`，防止闪错主题

**代码组织**

index.html（现 780 行）拆为：`index.html`（结构）+ `assets/app.css` + `assets/theme.css` + `assets/app.js`；服务端加 `/assets/*` 静态路由（白名单 + 路径穿越防护）。其余文档页保持单文件，只引入 `theme.css`。

## 边界情况

- **运行中切会话**：容器只隐藏；run/continue 循环照常，事件继续进对应容器
- **两个标签页同会话**：都渲染；后开的从历史还原时，正在流式输出的轮次只能从当前片段开始。已知限制，文档标注
- **旧数据迁移**：启动时前端发现 localStorage 会话不在列表，自动 `POST /api/sessions` 补建（标题取该会话首条历史消息）
- **删除运行中的会话**：确认弹窗后删除；驱动它的 run 循环后续 continue 报错，渲染为错误消息
- **停止按钮**：中断 continue 循环，最后一个 turn 元素标注「已停止」
- **运行中复制**：导出到最后一次落库的 `step_done` 为止，当前流式轮不含

## 兼容性（browser-extension-bff）

core 改动全部是可选字段；browser-extension-bff 工具为 remote 模式（不走服务端 execute），`llmDelta` 回调收到的对象多出 `sessionId`/`turnId` 被展开进事件，无行为影响。验证时同时跑 browser-extension-bff 测试套件确认零回归。

## 测试

| 层 | 测试 |
|---|---|
| core | harness 把 `sessionId`/`callId` 传进工具执行上下文；`complete` 请求携带 `sessionId` |
| adapter-sqlite | 同一次 complete 的所有 delta 携带相同 `turnId`+`sessionId`，跨次调用 `turnId` 不同 |
| flutter-dev-bff | 会话 CRUD 端点；export 的 Markdown 结构与截断档位；删除同时清理两张表；tool 事件携带 sessionId/callId |
| browser-extension-bff | 现有测试全部保持通过（兼容性回归） |
| WebUI | 无前端测试设施，浏览器手动验证清单（多会话并行、运行中切换、断线重连重放、复制、主题切换）写进实施计划 |

## 交付

新分支 `feature/webui-multi-session`；完成后走 finishing-a-development-branch 流程合并。
