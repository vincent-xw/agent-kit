import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  runAgent, connectEventSource, loadMessages, loadSessions, deleteSession,
  loadSkills, saveSkill as apiSaveSkill, deleteSkill as apiDeleteSkill,
  loadFiles, fileDownloadUrl, deleteFile as apiDeleteFile, uploadFiles,
  getSessionId, setSessionId,
} from '../api'
import type {
  ConversationTurn, ExecutorStatus, SessionMeta, Skill, StoredFile, TaskPlan, ToolStep,
} from '../types'
import { formatOutput } from '../utils'

/**
 * 会话控制器。
 *
 * API 与原插件 useFreeFormController 保持一致，FreeFormPanel 模板可直接复用。
 * 数据来源改为 BFF（REST + SSE），不再插件轮询。
 */
export function useConversation() {
  // ── 状态 ──
  const instruction = ref('')
  const turns = ref<ConversationTurn[]>([])
  const currentSteps = ref<ToolStep[]>([])
  const sessionId = ref(getSessionId())
  const sessions = ref<SessionMeta[]>([])
  const skills = ref<Skill[]>([])
  const allFiles = ref<StoredFile[]>([])
  const selectedFileIds = ref<Set<string>>(new Set())

  const runState = ref<'idle' | 'running' | 'succeeded' | 'failed'>('idle')
  const runError = ref<{ message: string; details?: string } | null>(null)
  const isPlanning = ref(false)
  const pendingPlan = ref<TaskPlan | null>(null)
  const planReasoning = ref('')
  const isStopping = ref(false)

  const executorStatus = ref<ExecutorStatus>({ online: false })

  // 弹窗/面板
  const toolsHelpVisible = ref(false)
  const toolsHelpAcknowledged = ref(true)
  const fileManagerVisible = ref(false)
  const fileInputRef = ref<HTMLInputElement | null>(null)
  const screenshotPreviewVisible = ref(false)
  const previewingScreenshot = ref<(StoredFile & { url: string }) | null>(null)

  let abortController: AbortController | null = null
  let closeEventSource: (() => void) | null = null

  // ── 计算属性 ──
  const isBusy = computed(() => runState.value === 'running' || isPlanning.value)
  const canSubmit = computed(() => instruction.value.trim().length > 0 && !isBusy.value)
  const canSaveSkill = computed(() => turns.value.length > 0 && !isBusy.value)
  const sessionIndex = computed(() => {
    const i = sessions.value.findIndex(s => s.id === sessionId.value)
    return i >= 0 ? i + 1 : sessions.value.length + 1
  })

  // ── 附件管理（对齐原 useFileAttachments）──
  const attachments = {
    selectedCount: () => selectedFileIds.value.size,
    isSelected: (id: string) => selectedFileIds.value.has(id),
    toggle: (id: string) => {
      const next = new Set(selectedFileIds.value)
      if (next.has(id)) next.delete(id); else next.add(id)
      selectedFileIds.value = next
    },
    buildFileList: () =>
      allFiles.value
        .filter(f => selectedFileIds.value.has(f.id) && !f.isImage && f.format !== 'xlsx')
        .map(f => ({ name: f.filename, size: f.size })),
  }

  function persistSession() { setSessionId(sessionId.value) }

  // ── SSE ──
  function connectSse() {
    closeEventSource?.()
    closeEventSource = connectEventSource((type, data) => {
      if (type === 'tool_start') {
        currentSteps.value.push({
          step: currentSteps.value.length + 1,
          toolName: String(data.toolName),
          input: data.input,
          output: null,
        })
      } else if (type === 'tool_end') {
        const step = currentSteps.value.find(s => s.toolName === data.toolName && s.output === null)
        if (step) step.output = data.outputPreview
      } else if (type === 'executor_status') {
        executorStatus.value = { online: !!data.online, tabUrl: data.tabUrl as string | undefined, tabTitle: data.tabTitle as string | undefined }
      }
    })
  }

  // ── 数据加载 ──
  async function refreshSessions() {
    try { sessions.value = await loadSessions() } catch { /* ignore */ }
  }

  async function refreshFiles() {
    try { allFiles.value = await loadFiles() } catch { /* ignore */ }
  }

  async function refreshSkills() {
    try { skills.value = await loadSkills() } catch { /* ignore */ }
  }

  /** 从 BFF 消息历史重建 turns。 */
  async function loadHistory() {
    const messages = await loadMessages().catch(() => [])
    const result: ConversationTurn[] = []
    const referencedFileIds = new Set<string>()

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (m.role === 'user') {
        result.push({ role: 'user', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), steps: [], files: [] })
      } else if (m.role === 'assistant' && m.content && !m.toolCalls) {
        const steps: ToolStep[] = []
        let j = i + 1
        while (j < messages.length && messages[j].role === 'tool') {
          steps.push({ step: steps.length + 1, toolName: messages[j].toolName ?? '', input: null, output: messages[j].content })
          const out = messages[j].content as Record<string, unknown> | null
          if (out && (out.fileId || out.screenshotId)) {
            referencedFileIds.add(String(out.fileId || out.screenshotId))
          }
          j++
        }
        result.push({
          role: 'agent',
          text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          steps,
          files: [],
        })
        i = j - 1
      }
    }
    turns.value = result

    if (referencedFileIds.size) {
      await refreshFiles()
      for (const turn of result) {
        turn.files = allFiles.value.filter(f => referencedFileIds.has(f.id))
      }
    }
  }

  // ── 计划流程 ──
  async function requestPlan() {
    const text = instruction.value.trim()
    if (!text || isBusy.value) return
    isPlanning.value = true
    runError.value = null
    pendingPlan.value = null
    planReasoning.value = ''
    try {
      const result = await runAgent(text, { currentDate: new Date().toISOString() }, 'planning', true)
      if (result.type !== 'final') {
        runError.value = { message: '计划阶段意外收到工具调用请求。' }
        return
      }
      pendingPlan.value = result.output as TaskPlan
      planReasoning.value = result.reasoning || ''
    } catch (error) {
      runError.value = { message: error instanceof Error ? error.message : String(error) }
    } finally {
      isPlanning.value = false
    }
  }

  async function confirmPlan() {
    if (!pendingPlan.value) return
    pendingPlan.value = null
    await submitInstruction()
  }

  function rejectPlan() {
    pendingPlan.value = null
    planReasoning.value = ''
    runState.value = 'idle'
    runError.value = null
  }

  // ── 执行 ──
  async function submitInstruction() {
    const text = instruction.value.trim()
    if (!text || isBusy.value) return
    instruction.value = ''
    currentSteps.value = []
    runState.value = 'running'
    runError.value = null
    abortController = new AbortController()
    turns.value.push({ role: 'user', text, steps: [], files: [] })

    const context: Record<string, unknown> = { currentDate: new Date().toISOString() }
    const fileList = attachments.buildFileList()
    if (fileList.length) context.fileList = fileList

    try {
      const result = await runAgent(text, context, 'free-form', false, abortController.signal)
      const output = formatOutput(result.output)
      await refreshFiles()

      const files: StoredFile[] = []
      for (const step of currentSteps.value) {
        const out = step.output as Record<string, unknown> | null
        if (out?.fileId) { const f = allFiles.value.find(x => x.id === out.fileId); if (f) files.push(f) }
        if (out?.screenshotId) { const f = allFiles.value.find(x => x.id === out.screenshotId); if (f) files.push(f) }
      }
      turns.value.push({ role: 'agent', text: output, steps: [...currentSteps.value], files })
      runState.value = 'succeeded'
      refreshSessions()
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') { runState.value = 'idle'; return }
      const message = error instanceof Error ? error.message : String(error)
      runError.value = { message }
      turns.value.push({ role: 'error', text: message, steps: [...currentSteps.value], files: [] })
      runState.value = 'failed'
    } finally {
      abortController = null
      isStopping.value = false
    }
  }

  function stop() {
    isStopping.value = true
    abortController?.abort()
  }

  // ── 会话管理 ──
  function startNewSession() {
    sessionId.value = crypto.randomUUID()
    persistSession()
    turns.value = []
    currentSteps.value = []
    runState.value = 'idle'
    runError.value = null
    pendingPlan.value = null
    connectSse()
    refreshSessions()
  }

  function handleSessionCommand(command: string | number | object) {
    if (command === '__new__') { startNewSession(); return }
    if (typeof command === 'string') switchSession(command)
  }

  function switchSession(id: string) {
    sessionId.value = id
    persistSession()
    turns.value = []
    currentSteps.value = []
    runState.value = 'idle'
    connectSse()
    loadHistory().catch(() => {})
    refreshSessions()
  }

  async function handleDeleteSession(id: string) {
    await deleteSession(id).catch(() => {})
    refreshSessions()
  }

  // ── 文件 ──
  function turnFiles(turn: ConversationTurn): Array<StoredFile & { url: string }> {
    return (turn.files ?? []).map(f => ({ ...f, url: fileDownloadUrl(f.id) }))
  }

  function downloadFile(file: StoredFile) {
    const a = document.createElement('a')
    a.href = fileDownloadUrl(file.id)
    a.download = file.filename
    a.click()
  }

  function openFileManager() {
    refreshFiles()
    fileManagerVisible.value = true
  }

  function triggerFilePicker() { fileInputRef.value?.click() }

  async function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement
    if (!input.files?.length) return
    await uploadFiles(Array.from(input.files)).catch(() => {})
    await refreshFiles()
    input.value = ''
    ElMessage.success('文件上传成功')
  }

  async function handleRemoveFile(id: string) {
    await apiDeleteFile(id).catch(() => {})
    const next = new Set(selectedFileIds.value); next.delete(id)
    selectedFileIds.value = next
    refreshFiles()
  }

  async function handleClearAllFiles() {
    for (const file of allFiles.value) await apiDeleteFile(file.id).catch(() => {})
    selectedFileIds.value = new Set()
    refreshFiles()
  }

  // ── 技能 ──
  async function handleSaveSkill() {
    const firstUser = turns.value.find(t => t.role === 'user')
    if (!firstUser) return
    const name = window.prompt('技能名称')?.trim()
    if (!name) return
    const lastAgent = [...turns.value].reverse().find(t => t.role === 'agent')
    try {
      await apiSaveSkill(name, firstUser.text, lastAgent?.text?.slice(0, 200) || '')
      ElMessage.success('技能已保存')
      refreshSkills()
    } catch {
      ElMessage.error('保存失败')
    }
  }

  function applySkill(skill: Skill) {
    startNewSession()
    instruction.value = skill.firstInstruction
    ElMessage.info(`已加载技能「${skill.name}」，确认后执行`)
  }

  // ── 截图预览 ──
  function previewScreenshot(file: StoredFile) {
    previewingScreenshot.value = { ...file, url: fileDownloadUrl(file.id) }
    screenshotPreviewVisible.value = true
  }

  // ── 工具帮助 ──
  function acknowledgeToolsHelp() {
    toolsHelpAcknowledged.value = true
    toolsHelpVisible.value = false
    localStorage.setItem('boos.toolsHelpAcknowledged', 'true')
  }

  // ── 复制 ──
  function copyTurnText(text: string, _index?: number) {
    navigator.clipboard.writeText(text).then(
      () => ElMessage.success({ message: '已复制', duration: 1500 }),
      () => ElMessage.warning('复制失败，请手动选择文本复制'),
    )
  }

  function copyStepDetail(step: ToolStep) {
    const lines = [
      `工具：${step.toolName}`,
      `入参：${JSON.stringify(step.input, null, 2)}`,
      `出参：${JSON.stringify(step.output, null, 2)}`,
    ]
    navigator.clipboard.writeText(lines.join('\n')).then(
      () => ElMessage.success({ message: '步骤详情已复制', duration: 1500 }),
      () => ElMessage.warning('复制失败'),
    )
  }

  function copyDiagnosticLog(turn: ConversationTurn) {
    const lines = [
      `时间: ${new Date().toISOString()}`,
      `会话: ${sessionId.value}`,
      `错误: ${turn.text}`,
      '',
      '步骤详情:',
      ...(turn.steps ?? []).map(s => `  ${s.step}. ${s.toolName}\n    入参: ${JSON.stringify(s.input)}\n    出参: ${JSON.stringify(s.output)}`),
    ]
    copyTurnText(lines.join('\n'))
  }

  // ── 初始化 ──
  function init() {
    toolsHelpAcknowledged.value = localStorage.getItem('boos.toolsHelpAcknowledged') === 'true'
    persistSession()
    connectSse()
    refreshSessions()
    loadHistory().catch(() => {})
    refreshFiles()
    refreshSkills()
  }

  return {
    // state
    instruction, turns, currentSteps, sessions, sessionId, skills, allFiles,
    runState, runError, isPlanning, pendingPlan, planReasoning, isStopping,
    executorStatus,
    toolsHelpVisible, toolsHelpAcknowledged,
    fileManagerVisible, fileInputRef, screenshotPreviewVisible, previewingScreenshot,
    // computed
    isBusy, canSubmit, canSaveSkill, sessionIndex,
    // helpers
    attachments, turnFiles,
    // actions
    requestPlan, confirmPlan, rejectPlan, submitInstruction, stop,
    startNewSession, handleSessionCommand, handleDeleteSession, switchSession,
    downloadFile, openFileManager, triggerFilePicker, handleFileSelect,
    handleRemoveFile, handleClearAllFiles, previewScreenshot,
    handleSaveSkill, applySkill,
    acknowledgeToolsHelp,
    copyTurnText, copyStepDetail, copyDiagnosticLog,
    init,
  }
}

export type Conversation = ReturnType<typeof useConversation>