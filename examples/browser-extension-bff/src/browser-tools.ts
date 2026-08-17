import { z } from 'zod'

import type { ToolDefinition } from '@agent-kit/core'

/**
 * 远端浏览器工具定义。这些工具全部 `execution: 'remote'`：
 * BFF 只负责告诉模型有哪些能力、并校验输入输出结构，真正的页面操作由扩展通过 WS 执行。
 *
 * 文件工具（save_file/read_file/write_file）在 server.ts 中以 server 工具动态注册，
 * 因为它们直接操作 BFF 磁盘，不需要浏览器参与。
 *
 * 坐标契约：x / y 一律是相对主页面 viewport 的 CSS 像素，不乘 devicePixelRatio。
 */
export const browserToolDefinitions: ToolDefinition[] = [
  {
    name: 'browser_snapshot',
    execution: 'remote',
    description:
      '获取当前页面所有可交互元素的结构化快照。每个元素带 ref（数字引用），后续点击/悬停/输入等操作都应优先使用 ref 而不是坐标。这是理解页面布局和定位元素的主要工具。每次页面发生显著变化（导航、弹窗、DOM 更新）后都应重新快照。不要在没有快照的情况下凭记忆操作——页面可能已经变了。',
    input: z.object({}),
    output: z.any(),
  },
  {
    name: 'browser_read_page',
    execution: 'remote',
    description:
      '读取当前页面的正文文本与标题。用于获取页面主要内容（文章正文、搜索结果列表、表单字段说明等），与 snapshot 互补：snapshot 给出可交互元素结构，read_page 给出正文内容。返回的 bodyPreview 是正文前 5000 字符的摘要。',
    input: z.object({}),
    output: z.any(),
  },
  {
    name: 'browser_locate_element',
    execution: 'remote',
    description:
      '在页面中定位元素。优先使用最近一次 snapshot 中的 ref；如果没有 ref（例如需要找动态出现的元素），可传 CSS selector。返回元素坐标和标签信息，供后续点击/悬停/输入使用。',
    input: z.object({
      ref: z.number().int().optional().describe('snapshot 中的元素引用编号'),
      selector: z.string().optional().describe('CSS 选择器，在没有 ref 时使用'),
      index: z.number().int().optional().describe('selector 匹配多个元素时取第几个（0 起）'),
    }),
    output: z.any(),
  },
  {
    name: 'browser_click',
    execution: 'remote',
    description:
      '点击页面元素。优先传 ref（来自 snapshot 或 locate_element），不要直接用 x/y 坐标——坐标在页面滚动或布局变化后会失效。点击后如果触发了导航，返回结果会包含 navigation 字段说明跳到了哪里。',
    input: z.object({
      ref: z.number().int().optional().describe('目标元素的 ref 编号'),
      x: z.number().optional().describe('CSS 像素 x 坐标（仅在无 ref 时使用）'),
      y: z.number().optional().describe('CSS 像素 y 坐标（仅在无 ref 时使用）'),
      label: z.string().optional().describe('元素的可读标签，用于日志和调试'),
    }),
    output: z.any(),
  },
  {
    name: 'browser_hover',
    execution: 'remote',
    description:
      '鼠标悬停在元素上。用于触发 hover 才出现的下拉菜单、tooltip 等。只移动鼠标不点击。传 ref 优先。',
    input: z.object({
      ref: z.number().int().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      label: z.string().optional(),
      settleMs: z.number().int().optional().describe('悬停后等待多少毫秒让菜单出现，默认 300'),
    }),
    output: z.any(),
  },
  {
    name: 'browser_wait_for',
    execution: 'remote',
    description:
      '等待页面达到某状态。condition=appear 等元素出现，disappear 等元素消失，stable 等 DOM 停止变化。用于点击后等加载、等弹窗、等动画结束。超时默认 10 秒。',
    input: z.object({
      condition: z.enum(['appear', 'disappear', 'stable']),
      selector: z.string().optional().describe('CSS 选择器，stable 时可省略'),
      timeoutMs: z.number().int().min(100).max(15000).optional(),
      stableMs: z.number().int().min(100).max(3000).optional(),
    }),
    output: z.any(),
  },
  {
    name: 'browser_input_text',
    execution: 'remote',
    description:
      '在输入框中输入文本。优先传 ref。会先点击目标获取焦点，再清空原有内容（clearFirst=true 时），然后逐字输入。输入后如果需要提交，再调用 browser_press_key 按 Enter。',
    input: z.object({
      ref: z.number().int().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      text: z.string().describe('要输入的文本'),
      clearFirst: z.boolean().optional().describe('是否先清空原有内容，默认 false'),
    }),
    output: z.any(),
  },
  {
    name: 'browser_press_key',
    execution: 'remote',
    description: '按下键盘按键。支持 Enter/Tab/Escape/Backspace/ArrowUp/ArrowDown。用于提交表单、切换焦点、关闭弹窗等。',
    input: z.object({
      key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown']),
      modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
    }),
    output: z.any(),
  },
  {
    name: 'browser_scroll',
    execution: 'remote',
    description: '滚动页面。deltaY 是滚动量（正值向下，负值向上）。x/y 可选，指定滚动起点。',
    input: z.object({
      deltaY: z.number().describe('纵向滚动量，正值向下'),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    output: z.any(),
  },
  {
    name: 'browser_verify',
    execution: 'remote',
    description:
      '验证页面状态。可以检查对话框是否出现、DOM 是否变化、输入框值是否正确、按钮是否启用，以及网络请求是否发出。返回每个检查维度的通过/失败结果。',
    input: z.object({
      expectDialog: z.boolean().optional(),
      expectDomChangeIn: z.number().int().optional().describe('等待 DOM 变化的毫秒数'),
      expectInputValue: z
        .object({
          selector: z.string(),
          value: z.string(),
        })
        .optional(),
      expectButtonEnabled: z
        .object({
          selector: z.string(),
        })
        .optional(),
      expectNetwork: z
        .object({
          urlPattern: z.string(),
        })
        .optional(),
    }),
    output: z.any(),
  },
  {
    name: 'browser_screenshot',
    execution: 'remote',
    description: '截取当前视口的截图。截图会自动展示在对话区域，用户可以点击查看大图或下载。注意：截图内容不会返回给你，你无法「看到」画面；需要读取页面信息请用 browser_snapshot 或 browser_read_page。',
    input: z.object({
      format: z.enum(['png', 'jpeg']).optional(),
    }),
    output: z.object({
      screenshotId: z.string().optional(),
      width: z.number(),
      height: z.number(),
      persisted: z.boolean().optional(),
      message: z.string(),
    }),
  },
  {
    name: 'browser_go_back',
    execution: 'remote',
    description: '浏览器返回上一页。当点击链接触发了非预期导航时用它回到原页面。',
    input: z.object({}),
    output: z.any(),
  },
]

/** 候选人评估的输出协议 */
export const candidateAssessmentProtocol = z.object({
  decisions: z.array(
    z.object({
      index: z.number().int(),
      shouldFavorite: z.boolean(),
      reason: z.string(),
    }),
  ),
})

export const candidateAssessmentPrompt = [
  '你是招聘助手。请根据用户策略，判断候选人列表中每个候选人是否"建议跟进"。',
  '必须返回严格 JSON（不要 markdown，不要代码块，不要解释文字）。',
  'JSON 格式必须为：{"decisions":[{"index":0,"shouldFavorite":true,"reason":"..."}]}',
  'index 必须对应输入中的候选人 index；每个候选人都必须有一条 decision。',
  'reason 请简洁，中文，不超过50字。',
].join('\n')

export const freeFormPrompt = [
  '你是浏览器操作助手。根据用户指令，使用提供的工具完成网页操作。',
  '操作原则：',
  '1. 先调用 browser_snapshot 了解页面，再操作。不要凭猜测点击。',
  '2. 优先使用 ref 定位元素，坐标只在没有 ref 时使用。',
  '3. 每次写操作后检查是否发生了预期的导航或变化。',
  '4. 文件操作用 browser_save_file/browser_read_file/browser_write_file，这些工具在 BFF 服务端执行。',
  '5. browser_screenshot 不返回画面内容，只用于用户查看；需要页面信息请用 browser_snapshot 或 browser_read_page。',
].join('\n')

export const planningPrompt = [
  '你是任务规划助手。分析用户指令和当前页面快照，评估任务可行性并输出执行计划。',
  '不要执行任何工具操作，只输出计划。',
  '输出必须是严格 JSON：',
  '{"feasible":true/false,"confidence":"high/medium/low","summary":"概述","steps":[{"action":"步骤描述","tool":"工具名","write":true/false}],"risks":["风险1"],"cannotDo":["无法完成的部分"]}',
].join('\n')

export const planningProtocol = z.object({
  feasible: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string(),
  steps: z.array(z.object({
    action: z.string(),
    tool: z.string(),
    write: z.boolean(),
    note: z.string().optional(),
  })),
  risks: z.array(z.string()),
  cannotDo: z.array(z.string()),
})

export const browserAutomationPrompt = [
  '你是浏览器自动化助手。按步骤执行用户预先确认的计划。',
  '每一步操作后确认结果，遇到异常立即停止并报告。',
].join('\n')