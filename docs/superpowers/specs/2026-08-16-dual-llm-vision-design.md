# Flutter Dev BFF：双 LLM 视觉识图

## 目标

为 Agent 增加「看图」能力：当无障碍树（`mobile_snapshot`）或网页 DOM（`web_snapshot`）数据不足时，Agent 可调用截图分析工具，BFF 将截图发送给本地多模态视觉模型，返回文字描述后回灌主 LLM。

## 背景

`mobile_snapshot` 依赖 Android 无障碍树，在有大量图标、图片、自定义绘制控件或 WebView 内容未经调试时，返回的节点可能稀疏或缺失有用信息。`mobile_screenshot` 虽然能截图，但工具描述明确写着「用户可以在对话中查看」——Agent 本身看不到图片内容。

视觉模型填补的正是这个缺口。主 LLM（纯文本，如 deepseek）负责推理与工具编排，视觉模型（本地免费快，OpenAI 兼容 API）负责把截图转成文字描述。两者通过一个工具调用衔接，不修改核心 harness。

## 设计决策

### 视觉模型包装成工具，不改 core

把视觉模型调用封装为一个普通工具 `mobile_screen_analyze`，Agent 在需要时调用它。BFF 收到请求后：截图 → base64 → POST 视觉模型 → 返回文字描述。

不修改 `packages/core` 的 `AgentHarness`、`LlmClient` 或 `ToolExecutionContext`。视觉模型故障时工具返回 `ok: false`，主 LLM 收到错误信息后自行决定重试或降级，不影响 Agent 整体运行。

### 视觉模型输出为自由文本描述

视觉模型返回纯文本描述（如「屏幕上有登录页面，顶部标题「欢迎登录」，中间两个输入框（手机号和密码），底部有一个登录按钮」），不做结构化节点列表。结构化要求视觉模型提供准确的坐标与 bounds，当前多模态模型对此不稳定，且增加了 prompt 复杂度。

主 LLM 结合这段描述与 `mobile_snapshot` 的节点信息一起判断，自由度更高。

### 配置独立于主 LLM

视觉模型配置通过三个独立环境变量传入，与主 LLM 的 `LLM_API_KEY`/`BASE_URL`/`MODEL` 完全分离。

```
VISION_API_KEY=
VISION_MODEL=qwen-vl
VISION_BASE_URL=http://localhost:11434/v1
```

未配置时工具报错「未配置视觉模型」。不设默认值，不自动回退。

## 组件设计

### 新增工具

`mobile_screen_analyze`，注册在 `createDeviceTools` 中。

- input: `{ deviceSerial?: string }`
- output: `{ ok: boolean; description?: string; message: string }`
- timeoutMs: 30_000（截图+视觉模型调用可能比普通工具慢）

### 视觉模型客户端

新建 `src/services/vision-client.ts`，不依赖 `packages/core`。

```
export interface VisionClientConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export class VisionClient {
  constructor(private config: VisionClientConfig) {}

  async analyze(imageBase64: string): Promise<string> { ... }
}
```

`analyze` 方法：

1. 向 `${baseUrl}/chat/completions` 发送 POST 请求，OpenAI 兼容格式，content 为多模态数组（text + image_url）。
2. 超时 25 秒。
3. 成功时返回 `choices[0].message.content`。
4. 失败时（网络错误、非 2xx、JSON 解析失败）抛出错误，由工具 execute 捕获并转成 `ok: false`。

### 工具执行流程

```
execute(input):
  1. adb.screenshot() → Buffer
  2. Buffer → base64 PNG
  3. visionClient.analyze(base64) → description
  4. return { ok: true, description }
```

### 服务端装配

`createFlutterDevBff` 增加可选的 `VISION_API_KEY`/`VISION_BASE_URL`/`VISION_MODEL` 参数。仅在三个值都非空时创建 `VisionClient` 并注入 `FlutterToolServices`。

`FlutterToolServices` 接口增加 `vision?: VisionClient`（可选，未配置时为 undefined）。

主模块（`isMainModule` 块）从环境变量读取 `VISION_*` 配置并传入。

### 提示词

在 `freeFormPrompt` 的「注意事项」段追加：

```
- 当 mobile_snapshot 返回的节点较少或没有有用信息时，调用 mobile_screen_analyze
  获取屏幕截图的分析描述。该工具会截图并调用视觉模型分析屏幕内容，返回文字描述。
  描述中不包含可点击的 ref，需要结合 mobile_snapshot 的节点信息一起判断。
```

## 测试策略

- `VisionClient.analyze`：mock `fetch`，验证请求体包含 base64 图片、响应解析正确、网络错误被抛出。
- `mobile_screen_analyze` 工具：mock `VisionClient` 与 `adb.screenshot`，验证截图被保存、视觉模型被调用、结果正确返回。
- `createFlutterDevBff` 不传 `VISION_*` 时工具不可用，调用返回 `ok: false`。
- 现有 190+ 个测试保持通过。

## 范围之外

- 修改 `packages/core` 的 `AgentHarness` 或 `LlmClient`。
- 批量识别或视频流。
- 截图结果持久化到 session 历史。
- `debuggingPrompt` 和 `testingPrompt` 的提示词更新（它们不涉及 UI 操作，不需要视觉能力）。