# AGENTS.md

## 改动 `packages/` 基础模块时，两个 BFF 必须同步验证

`packages/` 下的四个包（`core`、`bff-hono`、`adapter-sqlite`、`adapter-cloudflare`）是共享基础模块。`examples/` 下有两个消费方：

- `examples/browser-extension-bff`
- `examples/flutter-dev-bff`

**修改基础模块后，必须确认两个 BFF 都仍然正确，不允许只改一个。**

### 为什么容易漏

两个 BFF 消费同一套接口的方式截然不同，因此一处改动很容易只在其中一个上暴露问题：

| 维度 | browser-extension-bff | flutter-dev-bff |
|------|----------------------|-----------------|
| 工具执行方式 | 全部 `execution: 'remote'`（16 个） | 全部 `execution: 'server'`（21 个） |
| `execute` 字段 | 不提供，由 Chrome 扩展回填结果 | 全部提供，BFF 进程内执行 |
| 工具定义形态 | 扁平数组 | 工厂函数注入有状态服务 |
| 状态 | 无状态 | 有状态（`flutter run` 长进程、VM Service 连接） |
| Tool Host | Chrome 扩展 | BFF 内置 Web UI |

典型陷阱：只在 remote 路径上验证的改动会漏掉 `execute` 相关回归；只在 server 路径上验证的改动会漏掉 `PendingCallStore` 与 `tool-results` 回填协议。改 `ToolExecutionContext`、`ToolDefinition`、harness 循环或 `bff-hono` 路由时尤其如此。

`adapter-cloudflare` 没有对应的 example，改动它需要对照 [Cloudflare Worker 接入](docs/integrations/cloudflare-worker.md) 人工核对。

### 验证步骤

改动基础模块后，先确认两个 example 里的实际引用点：

```bash
grep -rn "<改动的符号>" examples/ packages/ --include=*.ts
```

再跑全 workspace 校验，三条命令都必须通过：

```bash
pnpm -r typecheck && pnpm -r test && pnpm -r build
```

只跑单个包的测试不算通过。`pnpm -r test` 会同时执行两个 example 的测试套件，这是防漏的最后一道闸。

### 破坏性改动

若改动无法同时兼容两个 BFF，不要单方面挑一个适配：先说明冲突点和取舍，确认后再动手。共享契约的变更影响所有下游，包括尚未建 example 的 Cloudflare 路径。

优先选择在 BFF 层包装而非修改共享契约。例如 flutter-dev-bff 的工具事件埋点通过 map 包装 `ToolDefinition.execute` 实现，没有给 `ToolExecutionContext` 加字段，因此对 browser-extension-bff 零影响。
