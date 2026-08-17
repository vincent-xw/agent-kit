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
              text: '请描述这个手机屏幕上的内容，包括所有可见的UI元素、文字、按钮和输入框。注意屏幕上的中文内容，按从上到下的顺序描述。简短描述，不超过200字。',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${imageBase64}` },
            },
          ],
        },
      ],
      max_tokens: 500,
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

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('视觉模型响应缺少 choices[0].message.content')
    return content
  }
}