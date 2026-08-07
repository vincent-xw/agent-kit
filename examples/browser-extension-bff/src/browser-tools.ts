import { z } from 'zod'

import type { ToolDefinition } from '@agent-kit/core'

/**
 * 远端浏览器工具定义。这些工具全部 `execution: 'remote'`：
 * BFF 只负责告诉模型有哪些能力、并校验输入输出结构，真正的页面操作由扩展执行。
 *
 * 坐标契约：x / y 一律是相对主页面 viewport 的 CSS 像素，不乘 devicePixelRatio。
 * 这条契约必须写进 description，否则模型无从知晓，而错误的后果是「点了但点错且不报错」。
 */

/** 元素定位意图。三种方式任选：ref（推荐）、显式选择器、预设角色。 */
const locatorSchema = z.object({
  ref: z.number().int().optional().describe('来自 browser_snapshot 的元素引用。自由操作时优先用这个'),
  role: z
    .enum(['candidateListItem', 'candidateName', 'resumeContainer', 'favoriteButton', 'greetButton', 'messageInput', 'sendButton', 'dialog'])
    .optional()
    .describe('预设元素角色，仅用于 BOSS 直聘的既有流程'),
  selector: z.string().optional().describe('显式 CSS 选择器'),
  index: z.number().int().optional().describe('同一条件匹配到多个元素时的序号，从 0 开始'),
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
    name: 'browser_snapshot',
    execution: 'remote',
    description:
      '列出当前视口内所有可交互元素及其 ref 编号。这是自由操作的**起点**：先快照看清页面上有什么，再用 ref 指定目标，不要凭猜测写选择器。页面变化（点击、滚动、导航）后需要重新快照。',
    input: z.object({}),
    output: z.object({
      url: z.string(),
      title: z.string(),
      entries: z.array(
        z.object({
          ref: z.number().describe('元素引用，用于后续 click / input_text 等动作'),
          tag: z.string(),
          label: z.string().describe('可读标签：aria-label / placeholder / 文本内容等'),
          kind: z.string().describe('元素类型，例如 button / link / textbox / checkbox'),
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
          occluded: z.boolean().optional().describe('为真表示被遮挡，不应直接点击'),
          disabled: z.boolean().optional(),
          value: z.string().optional().describe('输入类元素的当前值'),
        }),
      ),
      truncated: z.number().optional().describe('因数量上限被省略的元素数；大于 0 说明还有元素没列出'),
    }),
  },
  {
    name: 'browser_read_page',
    execution: 'remote',
    description: '读取当前页面的标题、URL 与正文摘要。只读操作，不改变页面状态。需要操作元素时用 browser_snapshot。',
    input: z.object({
      includeCandidateList: z.boolean().optional().describe('是否同时读取候选人列表（BOSS 直聘专用）'),
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
    name: 'browser_locate_element',
    execution: 'remote',
    description:
      '定位元素并返回其中心坐标与可点击性判定。已有 ref 时不必调用本工具 —— click / input_text 直接接受 ref 并会自行取最新坐标。',
    input: locatorSchema,
    output: locateResultSchema,
  },
  {
    name: 'browser_click',
    execution: 'remote',
    description:
      '执行真实点击（CDP 三段鼠标事件）。优先传 ref —— 扩展会按 ref 取当前坐标，无需你关心坐标是否过期。也可直接传 x/y，但那必须来自刚刚一次定位。',
    input: z
      .object({
        ref: z.number().int().optional().describe('来自 browser_snapshot 的元素引用（推荐）'),
        x: z.number().optional().describe('横坐标，CSS 像素，不乘 devicePixelRatio。传了 ref 就不必传'),
        y: z.number().optional().describe('纵坐标，CSS 像素，不乘 devicePixelRatio。传了 ref 就不必传'),
        label: z.string().optional().describe('用于日志的可读标签，例如「搜索按钮」'),
      })
      .describe('ref 与 x/y 至少给一组'),
    output: actionResultSchema,
  },
  {
    name: 'browser_input_text',
    execution: 'remote',
    description:
      '向输入框写入文本（含中文）。会先点击目标建立真实焦点，再经 CDP Input.insertText 写入；焦点未落上则直接失败，不会写入。优先传 ref。',
    input: z
      .object({
        ref: z.number().int().optional().describe('输入框的 ref（推荐）'),
        x: z.number().optional().describe('输入框中心横坐标，CSS 像素'),
        y: z.number().optional().describe('输入框中心纵坐标，CSS 像素'),
        text: z.string().describe('要写入的完整文本'),
        clearFirst: z.boolean().optional().describe('写入前是否先全选删除已有内容'),
      })
      .describe('ref 与 x/y 至少给一组'),
    output: actionResultSchema.extend({
      focused: z.boolean().optional(),
      actualValue: z.string().optional().describe('写入后读回的输入框内容'),
    }),
  },
  {
    name: 'browser_press_key',
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
    name: 'browser_scroll',
    execution: 'remote',
    description: '滚动页面。滚动后所有坐标与快照都已过期，必须重新调用 browser_snapshot。',
    input: z.object({
      deltaY: z.number().describe('纵向滚动量，正值向下'),
      x: z.number().optional().describe('滚动锚点横坐标，CSS 像素；省略则使用视口中心'),
      y: z.number().optional().describe('滚动锚点纵坐标，CSS 像素；省略则使用视口中心'),
    }),
    output: actionResultSchema,
  },
  {
    name: 'browser_verify',
    execution: 'remote',
    description:
      '验证上一个动作是否真的生效。不要以 browser_click 返回 ok 就认为成功 —— 命令下发成功不等于页面产生了变化。按需组合多个维度。',
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
    name: 'browser_screenshot',
    execution: 'remote',
    description: '截取当前视口。用于在快照信息不足、或反复定位失败时观察页面实际状态。',
    input: z.object({
      format: z.enum(['png', 'jpeg']).optional(),
    }),
    output: z.object({
      dataUrl: z.string().describe('base64 data URL'),
      width: z.number(),
      height: z.number(),
    }),
  },
  {
    name: 'browser_go_back',
    execution: 'remote',
    description:
      '浏览器返回上一页。当写操作（尤其是点击链接）把你带到了非预期的页面——例如下载链接跳到了外部站点——时用它回到原页面继续任务。返回结果会包含 navigation 字段说明回到了哪里。这是写操作，会改变浏览历史。',
    input: z.object({}),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      navigation: z
        .object({
          from: z.string(),
          to: z.string(),
          changedDomain: z.boolean(),
          note: z.string(),
        })
        .optional(),
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
 * 自由指令提示词。这是默认提示词 —— 用户给一句自然语言指令，模型自己规划动作序列。
 *
 * 重点交代两件事：先快照后动作（否则模型会凭猜测写选择器），以及每步验证
 * （否则「命令没报错」会被当成成功）。
 */
export const freeFormPrompt = [
  '你在通过一组浏览器工具操作用户当前打开的网页。用户会用自然语言描述想做的事，由你规划并执行。',
  '',
  '工作方式：',
  '1. 先调用 browser_snapshot 看清页面上有哪些可交互元素。不要凭猜测写 CSS 选择器。',
  '2. 用快照返回的 ref 指定操作目标（browser_click({ref: 5})）。扩展会按 ref 取当前坐标，你不必关心坐标是否过期。',
  '3. 每次只执行一个写动作（click / input_text / press_key / scroll / go_back）。',
  '4. 动作之后用 browser_verify 确认页面真的变了。命令返回 ok 不等于动作生效。',
  '5. 页面发生变化后（点击、滚动、导航、弹窗出现）重新 browser_snapshot —— 旧 ref 可能已失效。',
  '',
  '导航偏离处理（重要）：',
  '- 点击链接、按回车等写动作可能导致页面跳转到新地址。动作返回值里如果带 navigation 字段，说明发生了导航，务必读它。',
  '- navigation.changedDomain 为真表示你离开了原来的域名。如果这不是用户预期的跳转（例如下载链接把你带到了 GitHub 等外部站点），立即调用 browser_go_back 回到原页面，不要在错误的页面上继续操作。',
  '- 在未授权的域名上写操作会被拒绝。遇到这种情况不要停止任务，调用 browser_go_back 回到已授权的页面继续。',
  '- go_back 返回后用 browser_snapshot 确认回到了预期页面，再继续。',
  '',
  '注意事项：',
  '- 快照返回 occluded 为真的元素不要直接点击，先处理遮挡（关闭浮层或滚动）。',
  '- 快照返回 truncated 大于 0 说明还有元素没列出，需要时滚动后重新快照。',
  '- ref 失效（stale）时不要重试同一个 ref，重新快照取新的。',
  '- 用户的写操作可能需要本人逐个批准，被拒绝时不要绕道重试，直接说明该动作未获批准。',
  '- 某些域名与路径不在允许范围内，写操作会被拒绝。遇到这种情况说明原因，不要尝试其他方式。',
  '- 不要假装自己还在原页面上操作 —— 如果页面已经导航，你必须根据 navigation 提示或重新快照来确认当前位置。',
  '',
  '完成后用简洁的中文说明你做了什么、结果如何。若中途失败，说明失败在哪一步、观测到什么。',
].join('\n')

/**
 * 计划阶段提示词。
 *
 * 在执行前让模型评估任务可行性并输出结构化计划。不带 tools，模型只能输出文本。
 * context 里会带页面快照，模型据此判断当前页面是否足够支撑任务。
 */
export const planningPrompt = [
  '你是一个浏览器自动化任务的规划助手。用户会用自然语言描述想做的事，你的职责是评估可行性并输出执行计划。',
  '',
  '你会收到当前页面的快照信息（在 context 字段里），包含页面 URL、标题和可交互元素列表。',
  '结合快照信息和用户的任务描述，输出一个结构化的执行计划。',
  '',
  '输出格式（严格 JSON）：',
  '{',
  '  "feasible": true/false,',
  '  "confidence": "high" | "medium" | "low",',
  '  "summary": "一句话总结这个任务要做什么",',
  '  "steps": [',
  '    { "action": "步骤描述", "tool": "工具名", "write": true/false, "note": "风险或注意事项" }',
  '  ],',
  '  "risks": ["风险点1", "风险点2"],',
  '  "cannotDo": ["做不到的部分1", "做不到的部分2"]',
  '}',
  '',
  '可用工具：',
  '- browser_snapshot: 快照页面可交互元素',
  '- browser_read_page: 读取页面标题/URL/正文',
  '- browser_locate_element: 定位元素取坐标',
  '- browser_click: 真实点击（写操作）',
  '- browser_input_text: 输入文本（写操作）',
  '- browser_press_key: 按键（写操作）',
  '- browser_scroll: 滚动（写操作）',
  '- browser_go_back: 返回上一页（写操作）',
  '- browser_verify: 验证动作是否生效',
  '- browser_screenshot: 截图',
  '',
  '评估要点：',
  '- 当前页面上有没有完成任务所需的元素？如果没有，任务可能不可行。',
  '- 是否需要导航到其他域名？如果是，标注风险（未授权域名写操作会被拒绝）。',
  '- 是否需要大量重复操作？如果是，评估步骤数是否合理。',
  '- 如果任务无法完成，feasible 设为 false，在 cannotDo 里说明原因和建议。',
  '- 如果任务简单且高置信度，confidence 设为 high，steps 可以简短。',
  '',
  '不要执行任何操作，只分析和规划。输出严格 JSON，不要 markdown。',
].join('\n')

/** 计划输出的 Zod 协议。 */
export const planningProtocol = z.object({
  feasible: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string(),
  steps: z.array(
    z.object({
      action: z.string(),
      tool: z.string(),
      write: z.boolean(),
      note: z.string().optional(),
    }),
  ),
  risks: z.array(z.string()),
  cannotDo: z.array(z.string()),
})

/**
 * 浏览器自动化系统提示词（BOSS 直聘预设流程专用）。
 * 与自由指令的区别是它假定了固定的业务动作序列。
 */
export const browserAutomationPrompt = [
  '你在通过一组浏览器工具操作真实网页，目标站点是 BOSS 直聘。',
  '',
  '执行纪律（必须遵守）：',
  '1. 每一步只执行一个写动作（click / input_text / press_key / scroll）。',
  '2. 每个写动作之前，必须先调用 browser_locate_element 重新取坐标。不要复用上一步的坐标。',
  '3. 每个写动作之后，必须调用 browser_verify 确认页面真的变了。命令返回 ok 不等于动作生效。',
  '4. 若 verify 未通过，不要继续下一步，直接说明失败发生在哪一步及观测到的实际值。',
  '5. 若 locate_element 返回 occluded 为真，不要点击，先处理遮挡（例如关闭浮层或滚动）。',
  '',
  '坐标一律使用工具返回的 CSS 像素值，不要自行换算或缩放。',
].join('\n')
