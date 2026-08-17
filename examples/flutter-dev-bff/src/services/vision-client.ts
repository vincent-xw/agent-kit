export interface VisionClientConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export class VisionClient {
  constructor(
    private config: VisionClientConfig,
    private options: { fetchImpl?: typeof fetch } = {},
  ) {}

  private get fetch(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  async analyze(imageBase64: string): Promise<string> {
    const url = `${this.config.baseUrl}/chat/completions`
    const body = {
      model: this.config.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '这是一个手机 App 的屏幕截图，背景干净、UI 元素规整排列。请按从上到下的顺序，列出所有可见的：\n- 顶部状态栏信息\n- 分类标签/选项卡\n- 应用图标及其名称（逐行、逐项）\n- 底部导航栏或搜索栏\n- 角标数字\n\n注意事项：\n- 这是一台手机的单屏截图，不是多台手机的对比图\n- 文字识别请尽量准确，不要编造不存在的应用\n- 如果某行有多个应用，请逐项列出\n- 请完整描述，不要省略细节',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${imageBase64}` },
            },
          ],
        },
      ],
      max_tokens: 4096,
    }

    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`视觉模型请求失败: HTTP ${response.status} ${text.slice(0, 200)}`)
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
    }
    const msg = data.choices?.[0]?.message
    // 部分模型（如 deepseek-r1、gemma 推理版）用 reasoning_content 而非 content
    const content = msg?.content || msg?.reasoning_content
    if (!content) throw new Error('视觉模型响应缺少 choices[0].message.content')
    return content
  }
}