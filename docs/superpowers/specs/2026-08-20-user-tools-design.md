# Flutter Dev BFF：辅助用户工具集（host 文件 / 问询交互 / 受控执行 / 通知 / 出网 / 剪贴板）

日期：2026-08-20
状态：已确认（用户逐节审阅 + 逐问澄清通过）

## 背景与问题

flutter-dev-bff 现有工具集中在三块：设备/UI（`mobile_*`）、WebView（`web_*`）、Flutter 开发（`flutter_*`）。**没有任何文件读写、用户问询、host 命令执行、出网抓取、剪贴板、桌面通知类工具**，意味着 agent 无法：
- 在用户工作区读写文件（查看配置、导出结果、改写项目文件）
- 在流程中途向用户提问、请用户选择（像 Codex / Claude Code 的 ask-and-answer）
- 在用户电脑上跑命令、抓取文档、发通知、读写剪贴板

目标是在最小侵入既有体系的前提下，补齐「辅助用户」方向的一批 host + 交互工具，并给高危能力加上审慎的权限模型。

## 目标

- 7 个新增内置工具：`host_file_list`、`host_file_read`、`host_file_write`、`host_exec`、`host_notify`、`web_fetch`、`host_clipboard`，加 1 个 `ask_user` 问询工具（共 8 个）
- `ask_user` 同时支持单选与多选，前端选项按钮 + 输入框「其他」
- 阻塞式问询：agent 询问时暂停 LLM 循环，用户作答后带着答案继续（方案 A）
- 分级权限：默认读放行、写/执行先确认；设置面板「受信任 host 模式」开关放开确认
- 全流程沿用既有 `sessionId`/`callId` 链路与 SSE，加性改动，不回归现有测试

## 非目标

- 设备端文件读写（任意 APP 私有目录/共享存储）——自由写入任意 APP 预设目录不可靠（非 debuggable 应用受限、部分目录受 selinux 保护），整轮不做，遇真实需求再议
- 任意路径的 host 文件访问——**锁死在工作区根目录内**
- host_exec 的交互式 PTY、后台驻留进程管理（本轮只做一次性受控执行）
- 出网的任意目标——默认只读 + 白名单
- 前端框架化（保持原生 HTML/JS/CSS）

## 关键决策（逐问澄清结论）

| 问题 | 结论 |
|---|---|
| host 文件作用域 | **锁死工作区根目录**（入场即限根，路径必须解析进根内，杜绝 `..` 越权） |
| 设备端文件能力 | **整轮不做**（任意 APP 目录写入不可靠，留待有真实需求再议） |
| 问询形态 | **选项 + 输入框带「其他」**；同时支持单选与多选 |
| 附加工具 | 全选：`host_exec`、`host_notify`、`web_fetch`、`host_clipboard` |
| 权限模型 | **分级开关**：默认读放行、写/执行先走 `ask_user` 确认；「受信任 host 模式」开关放开 |
| ask 机制 | **方案 A：阻塞式工具 + 进程内待答存储** |

## 架构方案（已选：方案 A）

**阻塞式 ask_user + 进程内 pendingAsks 存储。** 备选方案 B（复用远端 pending/resume，把 ask 建模成 remote 工具）因更重、前端 run 循环要区分 resume 而放弃；方案 C（非阻塞、用户下句当答案）打断 LLM 循环、偏离 Codex/Claude 内联问询体验而放弃。

核心机制：`ask_user.execute()` 发 `ask_user` SSE 事件 → 把 callId 登记进 `pendingAsks` map → `await` 一个 promise；WebUI 收事件渲染问答卡片，作答后 `POST /api/asks/:callId`，服务端 resolve promise，工具把答案返回给 LLM，run/continue 请求照常返回，LLM 借答案继续循环。这块注意力成本最小、与既有阻塞工具 + SSE 完全同构。

## 设计

### 总览

| 工具 | 作用 | 归属 | 默认策略 |
|---|---|---|---|
| `host_file_list` | 列工作区根内目录 | host | 放行 |
| `host_file_read` | 读根内文本文件（截断） | host | 放行 |
| `host_file_write` | 写根内文件（覆盖/追加/新建） | host | 确认 |
| `ask_user` | 阻塞问询，单选/多选 + 其他 | 交互 | —— |
| `host_exec` | 受控执行 host 命令截输出 | host | 确认 |
| `host_notify` | 桌面通知 | host | 放行 |
| `web_fetch` | 抓 URL 文本 | 出网 | 受限放行 |
| `host_clipboard` | 读写剪贴板 | host | 读放行/写确认 |

### 共享基础设施：`askAndWait()`

`ask_user` 工具与高危工具的权限确认都复用同一个 `askAndWait()`：

```
askAndWait(services, { sessionId, callId, question, options, select })
  -> bus.emit({ type: 'ask_user', sessionId, callId, question, options, select })
       + pendingAsks.set(callId, { resolve, abort })
  -> await promise
  -> POST /api/asks/:callId { answer }   // 用户作答
  -> resolve({ answer })
```

- 挂载在注入到工具的服务集合（`FlutterToolServices`）里的 `askService`，暴露 `awaitAnswer(sessionId, callId, question, options, select): Promise<string | string[]>` 与 `cancel(callId)`
- 进程内 `pendingAsks` `Map<callId, { resolve, controller }>`，重启即丢（由工具 run 超时自愈）
- 高危工具确认是 `askAndWait` 的用法之一：问题携带待执行命令/路径，选项 `['允许', '拒绝']`

### `ask_user` 工具

- **输入 schema**：`{ question: string, select: 'single'|'multiple', options?: string[], default?: string }`
  - `select='multiple'` 时 `options.length >= 2`
  - `select='single'` 时 `options` 可空（纯输入）
- **执行流程**
  1. 校验 schema（非法选项/空问题 → `{ ok:false, error }` 而非抛异常，让 LLM 自愈）
  2. `bus.emit({ type:'ask_user', sessionId, callId, question, options, select })`
  3. `await askService.awaitAnswer(...)`
  4. 作答到达 → 输出 `{ answer: string | string[] }` 返回 LLM
- **输出写入历史**：答案作为 tool 消息入 `agent_sessions`，与其它工具一致
- **超时**：工具 `timeoutMs` 取较高值（如 300s）；超时返回 `{ timeout: true }` 让 LLM 知晓「用户未及时回复」
- **取消**：复用 `context.signal`——agent 侧取消 run 会中止 ask，`pendingAsks` 清掉对应条目
- **并发**：一次 run 内 LLM 单轮串行，至多一个未决 ask；跨会话独立

### 回填端点 `POST /api/asks/:callId`

- 鉴权与既有 `/api` 一致（Bearer token）
- Body：`{ answer?: string | string[] }`，callId 必须属于当前会话且未决；否则 404/409
- **一次作答即移除**，防重放
- 返回 `{ ok: true }`

### 权限模型（分级开关 + 联动）

- `HostPolicy` 服务：`Map<sessionId, boolean>`（受信任模式），进程重启即重置，按会话隔离
- WebUI 设置面板加「受信任 host 模式」开关（默认关），`GET/POST /api/settings` 读写
- **关（默认）**：
  - 放行：`host_file_list`、`host_file_read`、`host_clipboard`(read)、`web_fetch`(只读)、`host_notify`
  - 确认：`host_file_write`、`host_exec`、`host_clipboard`(write)——先走 `ask_user` 弹「允许在 host 执行/写入 <X>？」选项 `[允许, 拒绝]`；拒绝返回 `{ ok:false, denied:true }`
- **开**：高危工具全部直接执行，不再弹确认
- **根约束不因开关放宽**；`web_fetch` 白名单不因开关放宽

### host 工具细部

- 路径解析统一：相对路径以工作区根为基准；绝对路径必须解析进根内（`path.resolve` + 前缀比对，拒绝 `..` 逃逸），否则 `{ ok:false, error: 'path outside workspace' }`
- **`host_file_list`**：`{ path }` → `{ entries: [{ name, type:'file'|'dir', size?, modifiedAt }] }`；目录不存在 → `{ ok:false, error }`
- **`host_file_read`**：`{ path }` → `{ ok, content, truncated }`；文本读，截断到上限（默认 200KB）；二进制读前检测，返回可读提示
- **`host_file_write`**：`{ path, content, mode?: 'overwrite'|'append'|'create' }` → `{ ok, bytes, path }`；写入前走确认
- **`host_exec`**：`{ command, cwd?, timeoutMs? }` → `{ ok, stdout, stderr, exitCode, timedOut }`；`sh -c` 执行，输出截断（默认 64KB），越权/超时失败；确认文案含 command
- **`web_fetch`**：`{ url }` → `{ ok, status, text, blocked? }`；仅 http(s)，域名不得为本地回环/保留段；可选白名单 `HOST_FETCH_ALLOWED_HOSTS`（准用主体，未设则按回环+保留段禁止）；文本截断 200KB；不满足 → `{ ok:false, blocked:true }`
- **`host_clipboard`**：`{ action:'read'|'write', text? }` → `{ ok, text? }`；`pbcopy/pbpaste`（macOS）/ `xclip`（Linux），缺失返回错误；写需确认
- **`host_notify`**：`{ title, message? }` → `{ ok }`；`osascript`（macOS）/ `notify-send`（Linux），失败静默降级
- 输出一律截断，历史里留摘要不留全文（延续既有 truncate 约定）

## WebUI 呈现

### 问答卡片（`ask_user` 事件）

- `app.js` 新增 `ask_user` 事件监听：按 sessionId 路由（复用 `routeEvent`），当前会话 `#messages` 内渲染卡片；非当前会话收到点亮活动圆点
- 卡片结构：问题标题 → 选项区 → 输入框 → 提交
  - 单选：选项按钮，点即选中并立即提交；输入框可填「其他」
  - 多选：可勾选 chips + 输入框补充，点提交汇总 POST
- 交互期间输入栏/发送禁用（复用全局 `running`——阻塞式 run 下 `running` 已为 true）
- 历史还原：`restoreHistory` 遇到 ask 的 tool 消息渲染「已答：<答案>」折叠摘要，不可再编辑

### 设置面板

- 新增「受信任 host 模式」开关（默认关），经 `/api/settings` 读写，作用于当前会话的 `HostPolicy`

## 出错处理

- 工具内部错误统一 `{ ok:false, error }` 回给 LLM 如实说明，利于 agent 自愈（延续既有约定，避免随意抛异常）
- 越权/未确认/超时各自语义：`denied` / `blocked` / `timeout`；prompt 提示 LLM 如实转达用户
- 进程内 `pendingAsks` 重启即丢 → run 超时（300s）自愈，不永久挂起

## 测试

- `ask-user.test.ts`：单选/多选回填、重复作答被拒、超时、`context.signal` 中止、callId 越权拒绝、schema 非法
- `host-tools.test.ts`：路径越权（`..`、绝对路径落根外）全拒；写文件确认与受信任模式绕过；读截断；exec 超时/输出截断；web_fetch 白名单拒绝
- `HostPolicy` 单测：按会话隔离、默认关、开关读写
- 前端无测试基建，靠手动浏览器验证（问答卡片、单选/多选、受信任开关）
- 全部为加性改动，不回归既有 113 项测试；`@agent-kit/core` 不改契约，仅 BFF 层新增

## 风险与取舍

- `/run` 在 ask 期间保持打开：阻塞式设计的固有代价，超时兜底
- `host_exec` 能力强：靠「锁根 + 默认确认 + 受信任开关」三层托底；不承诺对恶意命令的安全（与 Claude Code 同等的信任模型）
- `web_fetch` 出网：白名单 + 回环/保留段拦截，降权限不稳定主机出网面