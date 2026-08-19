# 配置说明

所有配置通过环境变量或 `.env` 文件设置。复制 `.env.example` 为 `.env` 并修改。

## 必填配置

### AGENT_KIT_MASTER_KEY

32 字节 base64url 主密钥,用于加密存储在 SQLite 中的 LLM API Key。

生成方式:

```bash
openssl rand -base64 32 | tr +/ -_ | tr -d =
```

### BFF_API_TOKEN

Web UI 和 API 访问令牌。客户端通过 `Authorization: Bearer <token>` 发送。

### FLUTTER_PROJECT_PATH

Flutter 项目根目录(包含 pubspec.yaml)。

### LLM_API_KEY / LLM_MODEL / LLM_BASE_URL

主 LLM 配置,OpenAI 兼容接口:

```env
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat
LLM_BASE_URL=https://api.deepseek.com/v1
```

## 视觉模型(可选)

`mobile_screen_analyze` 工具使用的多模态模型:

```env
VISION_API_KEY=your-key
VISION_MODEL=qwen-vl-max
VISION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

或本地模型(LM Studio、Ollama 等):

```env
VISION_API_KEY=not-needed
VISION_MODEL=gemma-4-e4b-it-qat
VISION_BASE_URL=http://localhost:1234/v1
```

视觉模型的选择建议:

- 背景干净、元素规整的页面识别准确率高(85%+)
- 背景复杂(照片、壁纸)时可能出现误读,优先依赖 `mobile_snapshot`
- 提示词要求简短、结构化输出,避免模型在推理上消耗过多 token

## Android Companion App(可选)

用独立的 Android 无障碍服务替代 `uiautomator dump`,更快、更稳定:

```env
COMPANION_ENABLED=1
```

详见 [Companion App](companion.md)。

## 可选配置

### PORT

BFF HTTP 端口,默认 `8788`。

### LOG_LEVEL

- `info`(默认)— 关键事件
- `verbose` — 完整请求/响应日志(含发给 LLM 的 body,仅调试用)

### LLM_MAX_RETRIES

LLM 请求最大重试次数,默认 3。只重试网络错误和 5xx/429。

## 工作目录

BFF 在以下目录读写数据:

| 目录 | 用途 |
|------|------|
| `screenshots/` | 截图 PNG 文件 |
| `skills/` | Skill 文件(提示词、执行记录) |
| `tools/` | 用户自定义工具插件 |
| `flutter-dev-bff.sqlite` | 会话与密钥数据库 |

全局工具目录在 `~/.agentkit/tools/`。

## 输入法配置

中文等非 ASCII 文本输入需要 ADBKeyBoard:

```bash
pnpm ime:setup     # 安装并启用 ADBKeyBoard
pnpm ime:restore   # 还原为原输入法
```

ASCII 文本无需此配置。