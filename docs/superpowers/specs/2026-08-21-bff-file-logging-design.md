# Flutter Dev BFF：按日轮转文件日志（长期方案）+ WebUI 底部版权

日期：2026-08-21
状态：已确认（用户逐节审阅 + 澄清通过）

## 背景与目标

flutter-dev-bff 目前的日志只打到 console（`createConsoleAuditLogger` 打非敏感摘要；`createLlmVerboseLogger` 在 `LOG_LEVEL=verbose` 时打包含完整 LLM 输入输出的排障日志）。没有落盘、没有轮转。用户希望：

- BFF 增加**按日轮转、写文件**的日志，默认开启，目录可配
- 默认写 **verbose 格式（含 LLM 输入提示词/Prompt）**，用于跑一段时间量化日志体量
- 日志**写入格式可配置**，注释里说明支持几种、各自一句解释
- **长期使用**（非过渡方案，优先成熟库而非自研轮子）
- 附带：WebUI 底部加版权说明 `copyright xuewen.jia`

## 目标

- 按天轮转写文件日志，默认开，目录可配，保留天数可配（0=永久）
- 默认 `verbose`（完整 LLM 请求/响应含 prompt），格式可切换，.env 注释说明 3 种
- 长期方案：用 winston + winston-daily-rotate-file，不自行实现轮转
- WebUI 底部版权小字

## 非目标

- 干预 core 的日志事件模型——沿用现有 sink 注入管线，core 不改
- 日志的搜索/查看 UI（本轮只落盘，供终端/脚本看）
- 加密、脱敏改写 prompt（与用户量化体量意图相反；由用户自担并按需切回 audit）

## 架构方案（已选：方案 B，winston）

**winston + winston-daily-rotate-file**，作为 core 日志器的 file sink。

之前自研 sink 方案（方案 A）因「要长期用」被否决；shell 重定向（方案 C）无干净轮转/保留被否决。

接入路径保持不变：core 的 `createLlmVerboseLogger` / `createConsoleAuditLogger` 继续负责「把事件格式化成字符串」，只是把 `sink` 指向 winston logger 的写盘方法；轮转、切文件、保留清理全交给 winston。core 与既有 `instrumentTools`/`llmTraceToBus` 逻辑不动。

## 设计

### 新配置键（.env，写入模板并注释）

| 键 | 默认 | 说明 |
|---|---|---|
| `LOG_TO_FILE` | `1` | 落盘总开关（1=开/0=关） |
| `LOG_DIR` | `<BFF 数据目录>/logs` | 日志目录，可配 |
| `LOG_FORMAT` | `verbose` | 写入格式，支持 **3 种**（见下，仅启动时读一次） |
| `LOG_KEEP_DAYS` | `7` | 保留天数，`0`=永久保留；仅启动时读一次，改动需重启 |

模板注释里逐条中文说明，并对 `LOG_FORMAT` 写：
```
# LOG_FORMAT 支持的 3 种：
#   verbose —— 多行人类可读，含完整 LLM 输入输出（Prompt、会话历史、工具调用、模型原文），体量最大、不含 API Key
#   json    —— 每条事件一行 JSON，便于脚本/工具解析
#   audit   —— 仅非敏感摘要（requestId、模型、工具、耗时、HTTP 状态、错误码），不含任何 Prompt/业务内容
```

### 文件与轮转

- 文件：`<LOG_DIR>/bff-YYYY-MM-DD.log`，winston-daily-rotate-file 配置 `datePattern: 'YYYY-MM-DD'`、`maxFiles: LOG_KEEP_DAYS`（`0` 时表示不清理）。
- append 模式，跨天自动换新文件；启动 + 换天时由库清理超出保留天数的旧文件。
- winston 写日志本身是异步队列，单 BFF 进程内天然串行。

### 格式映射

`LOG_FORMAT` 决定 transport 的 `format` 与「是否把完整 LLM 载荷喂给文件」：

| LOG_FORMAT | 文件里写什么 | 触发方式 |
|---|---|---|
| `verbose`（默认） | 审计摘要行（非敏感摘要）+ 完整 LLM 请求/响应（含 prompt） | `format.simple()`，verbose/audit 两条管线都接 winston |
| `json` | 审计 + LLM 事件各一行 JSON | `format.json()`，两条管线都接 |
| `audit` | 仅非敏感审计摘要，不含 prompt | 只接 audit 管线，不把完整 LLM 载荷写入文件 |

接线：runtime 的 `llmTrace` 回调里，除了既有 `options.llmTrace` 与 `llmTraceToBus(bus)`，在 `LOG_FORMAT ∈ {verbose, json}` 时再喂给 winston；`audit` 摘要经 winston transport 落盘（所有格式都写）。

### 依赖

- `winston`
- `winston-daily-rotate-file`
- 类型：`@types/winston-daily-rotate-file`（如库自带类型则省略，以类型检查为准）

### 服务文件

- 新增 `examples/flutter-dev-bff/src/services/file-logger.ts`：导出 `createFileLogger(options)`，解析 `LOG_DIR`（默认数据目录/logs）、`LOG_FORMAT`、`LOG_KEEP_DAYS`，构造 winston logger + elastic file transport；对外返回一个可注入的 `{ sink }`（或直接按格式组装好的 audit + llm trace 回调），供 server.ts 使用。
- `server.ts`：读 env 配置 → 构造 file logger → 把 file sink 注入 audit logger；在 runtime `llmTrace` 回调里追加喂文件（按格式）。console 输出保持不变。

### WebUI 底部版权

- `public/index.html`：主区底部 `#input-bar` 之后加 `<div class="footer-copy">copyright © 2026 xuewen.jia</div>`
- `public/assets/app.css`：加 `.footer-copy { text-align:center; font-size:11px; color:var(--text2); padding:6px 0; }`（随亮/暗主题变量自动适配）

## 出错处理

- winston 初始化/写盘失败（目录不可写等）：不阻断 BFF 启动，记 stderr 警告并降级（该 transport 停用，console 不受影响）。
- `LOG_DIR` 不存在：启动时 `mkdir -p` 创建，失败再告警降级。

## 测试

- `file-logger.test.ts`：给定临时 `LOG_DIR` + 各 `LOG_FORMAT`，写入若干事件后断言文件行数与格式符合（verbose 含 prompt 关键字、json 每行可 parse、audit 不含 prompt）；`LOG_KEEP_DAYS` 生效（用不可靠 mtime 或直接断言 `maxFiles`/配置透传）。
- server.test：沿用现有构造，确认 `LOG_TO_FILE=0` 或未配置时不建文件/不崩。
- 手动浏览器验证 footer 版权出现且随主题适配。

## 风险与取舍

- 默认 `verbose` 将完整 Prompt 落盘，与代码安全红线相悖——用户明确要量化一整天体量，属知情选择；测完可切 `audit`/`json`。spec 按此记录。
- 新增 winston 依赖对 flutter-dev-bff 体积/冷启动影响小，换取长期可靠的轮转与保留能力。
- `LOG_KEEP_DAYS=0` 时文件永久累积，用户自担磁盘增长。