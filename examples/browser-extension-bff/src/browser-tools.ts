import { z } from 'zod'

import type { ToolDefinition } from '@agent-kit/core'

/**
 * 远端浏览器工具定义。这些工具全部 `execution: 'remote'`：
 * BFF 只负责告诉模型有哪些能力、并校验输入输出结构，真正的页面操作由扩展执行。
 *
 * 坐标契约：x / y 一律是相对主页面 viewport 的 CSS 像素，不乘 devicePixelRatio。
 * 这条契约必须写进 description，否则模型无从知晓，而错误的后果是「点了但点错且不报错」。
 */

/** 元素定位意图。选择器由扩展按「用户配置优先、站点 fallback 兜底」解析。 */
const locatorSchema = z.object({
  role: z
    .enum(['candidateListItem', 'candidateName', 'resumeContainer', 'favoriteButton', 'greetButton', 'messageInput', 'sendButton', 'dialog'])
    .describe('目标元素的语义角色，扩展据此选择对应的选择器列表'),
  selector: z.string().optional().describe('可选的显式 CSS 选择器；提供时优先于 role 对应的配置'),
  index: z.number().int().optional().describe('同一角色匹配到多个元素时的序号，从 0 开始'),
})

/** 定位结果：坐标 + 可点击性判定。 */
const locateResultSchema = z.object({
  found: z.boolean(),
  x: z.number().optional().describe('元素中心点横坐标，相对主页面 viewport 的 CSS 像素'),
  y: z.number().optional().describe('元素中心点纵坐标，相对主页面 viewport 的 CSS 像素'),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  visible: z.boolean().optional(),
  inViewport: z.boolean().optional(),
  occluded: z.boolean().optional().describe('中心点命中测试是否被其他元素遮挡'),
  occludedBy: z.string().optional(),
  matchedSelector: z.string().optional(),
  selectorSource: z.enum(['user-config', 'site-fallback']).optional().describe('命中来源，用于诊断选择器配置'),
  frameId: z.string().optional().describe('命中元素所在 frame 标识'),
  triedSelectors: z.array(z.string()).optional().describe('全部未命中时列出已尝试的选择器'),
  message: z.string().optional(),
})

/** 动作执行结果的公共形态。 */
const actionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  failedPhase: z.string().optional().describe('失败发生的阶段，例如 mousePressed'),
})

/** 单个验证维度的观测值。 */
const verifyDimensionSchema = z.object({
  dimension: z.enum(['dialogAppeared', 'domChanged', 'inputValue', 'buttonEnabled', 'networkRequest']),
  passed: z.boolean(),
  observed: z.string().describe('该维度的实际观测值，失败时用于定位原因'),
})

export const browserToolDefinitions: ToolDefinition[] = [
  {
    name: 'browser.read_page',
    execution: 'remote',
    description: '读取当前页面的标题、URL 与正文摘要。只读操作，不改变页面状态。',
    input: z.object({
      includeCandidateList: z.boolean().optional().describe('是否同时读取候选人列表'),
    }),
    output: z.object({
      title: z.string(),
      url: z.string(),
      bodyPreview: z.string(),
      candidates: z
        .array(z.object({ index: z.number(), name: z.string(), previewText: z.string() }))
        .optional(),
    }),
  },
  {
    name: 'browser.locate_element',
    execution: 'remote',
    description:
      '定位元素并返回其中心坐标与可点击性判定。每次执行写动作前都必须重新调用本工具重算坐标——弹窗、滚动、虚拟列表与重渲染都会让旧坐标失效。',
    input: locatorSchema,
    output: locateResultSchema,
  },
  {
    name: 'browser.click',
    execution: 'remote',
    description:
      '在给定坐标执行真实点击（CDP 三段鼠标事件）。坐标必须来自刚刚一次 browser.locate_element 的返回值，不要复用更早的坐标。',
    input: z.object({
      x: z.number().describe('横坐标，相对主页面 viewport 的 CSS 像素，不乘 devicePixelRatio'),
      y: z.number().describe('纵坐标，相对主页面 viewport 的 CSS 像素，不乘 devicePixelRatio'),
      label: z.string().optional().describe('用于日志的可读标签，例如「打招呼按钮」'),
    }),
    output: actionResultSchema,
  },
  {
    name: 'browser.input_text',
    execution: 'remote',
    description:
      '向输入框写入文本（含中文）。会先点击该坐标建立真实焦点，再经 CDP Input.insertText 写入；焦点未落上则直接失败，不会写入。',
    input: z.object({
      x: z.number().describe('输入框中心横坐标，CSS 像素'),
      y: z.number().describe('输入框中心纵坐标，CSS 像素'),
      text: z.string().describe('要写入的完整文本'),
    }),
    output: actionResultSchema.extend({
      focused: z.boolean().optional(),
      actualValue: z.string().optional().describe('写入后读回的输入框内容'),
    }),
  },
  {
    name: 'browser.press_key',
    execution: 'remote',
    description: '下发真实按键事件。用于 Enter、Tab、Escape、Backspace 与组合快捷键。',
    input: z.object({
      key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown']).describe('按键名'),
      modifiers: z
        .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
        .optional()
        .describe('组合键修饰符'),
    }),
    output: actionResultSchema,
  },
  {
    name: 'browser.scroll',
    execution: 'remote',
    description: '滚动页面或指定容器。滚动后所有已有坐标失效，必须重新定位。',
    input: z.object({
      deltaY: z.number().describe('纵向滚动量，正值向下'),
      x: z.number().optional().describe('滚动锚点横坐标，CSS 像素；省略则使用视口中心'),
      y: z.number().optional().describe('滚动锚点纵坐标，CSS 像素；省略则使用视口中心'),
    }),
    output: actionResultSchema,
  },
  {
    name: 'browser.verify',
    execution: 'remote',
    description:
      '验证上一个动作是否真的生效。不要以 browser.click 返回 ok 就认为成功——命令下发成功不等于页面产生了变化。按需组合多个维度。',
    input: z.object({
      expectDialog: z.string().optional().describe('期望出现的弹窗选择器'),
      expectDomChangeIn: z.string().optional().describe('期望文案或类名发生变化的元素选择器'),
      expectInputValue: z
        .object({ selector: z.string(), text: z.string() })
        .optional()
        .describe('期望某输入框的值等于给定文本'),
      expectButtonEnabled: z.string().optional().describe('期望变为可用的按钮选择器'),
      expectNetwork: z
        .object({ urlPattern: z.string(), expectSuccess: z.boolean().optional() })
        .optional()
        .describe('期望发出并成功返回的请求 URL 关键字'),
      timeoutMs: z.number().int().optional().describe('等待上限；轮询满足即提前返回'),
    }),
    output: z.object({
      passed: z.boolean(),
      dimensions: z.array(verifyDimensionSchema),
      timedOut: z.boolean().optional(),
      message: z.string(),
    }),
  },
  {
    name: 'browser.screenshot',
    execution: 'remote',
    description: '截取当前视口。用于在定位反复失败时观察页面实际状态。',
    input: z.object({
      format: z.enum(['png', 'jpeg']).optional(),
    }),
    output: z.object({
      dataUrl: z.string().describe('base64 data URL'),
      width: z.number(),
      height: z.number(),
    }),
  },
]

/** 候选人评估的输出协议，替代原扩展侧的手工 JSON 解析与容错。 */
export const candidateAssessmentProtocol = z.object({
  decisions: z.array(
    z.object({
      index: z.number().int(),
      shouldFavorite: z.boolean(),
      reason: z.string(),
    }),
  ),
})

/**
 * 候选人评估系统提示词。评分口径与原 `llmService.buildBatchPrompt` 保持一致：
 * 严格 JSON、index 必须对应输入、每人一条 decision、reason 中文且简洁。
 */
export const candidateAssessmentPrompt = [
  '你是招聘助手。请根据用户策略，判断候选人列表中每个候选人是否“建议跟进”。',
  '必须返回严格 JSON（不要 markdown，不要代码块，不要解释文字）。',
  'JSON 格式必须为：{"decisions":[{"index":0,"shouldFavorite":true,"reason":"..."}]}',
  'index 必须对应输入中的候选人 index；每个候选人都必须有一条 decision。',
  'reason 请简洁，中文，不超过50字。',
].join('\n')

/**
 * 浏览器自动化系统提示词。核心是把单步闭环约束交代清楚，
 * 否则模型会倾向于一次性规划多个坐标然后连续点击——那是坐标失效的主要来源。
 */
export const browserAutomationPrompt = [
  '你在通过一组浏览器工具操作真实网页，目标站点是 BOSS 直聘。',
  '',
  '执行纪律（必须遵守）：',
  '1. 每一步只执行一个写动作（click / input_text / press_key / scroll）。',
  '2. 每个写动作之前，必须先调用 browser.locate_element 重新取坐标。不要复用上一步的坐标。',
  '3. 每个写动作之后，必须调用 browser.verify 确认页面真的变了。命令返回 ok 不等于动作生效。',
  '4. 若 verify 未通过，不要继续下一步，直接说明失败发生在哪一步及观测到的实际值。',
  '5. 若 locate_element 返回 occluded 为真，不要点击，先处理遮挡（例如关闭浮层或滚动）。',
  '',
  '坐标一律使用工具返回的 CSS 像素值，不要自行换算或缩放。',
].join('\n')
