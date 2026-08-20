// Flutter Dev Agent WebUI：多会话管理 + 时序渲染
const TOKEN = localStorage.getItem('bff_token') || 'dev-token'
const $ = (id) => document.getElementById(id)
const messagesEl = $('messages')
const statusEl = $('status')
const promptEl = $('prompt')
const inputEl = $('input')
const sendBtn = $('send')
const stopBtn = $('stop')

let sessions = []
let currentSessionId = null
let running = false
let stopRequested = false
let showToolDetails = localStorage.getItem('show_tool_details') === '1'

// BFF 在 harness 调用前会给 sessionId 加上身份前缀（如 flutter-dev:xxx），
// 但 WebUI 的会话列表、视图与 localStorage 都使用原始 id，因此事件需要归一化。
const SUBJECT_PREFIX = 'flutter-dev:'
function normalizeSessionId(id) {
  return typeof id === 'string' && id.startsWith(SUBJECT_PREFIX) ? id.slice(SUBJECT_PREFIX.length) : id
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function relativeTime(iso) {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) },
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return res.json()
}

// ── 会话视图：每会话一个独立容器，切换只切显示，不销毁 DOM ──
const views = new Map()

function getView(sessionId) {
  let view = views.get(sessionId)
  if (!view) {
    const el = document.createElement('div')
    el.className = 'session-messages'
    messagesEl.appendChild(el)
    view = { el, loaded: false, lastSeq: 0, turns: new Map(), tools: new Map(), currentTurn: null, typingEl: null }
    views.set(sessionId, view)
  }
  return view
}

function showSession(sessionId) {
  for (const [sid, view] of views) view.el.classList.toggle('active', sid === sessionId)
}

// ── 会话列表与边栏 ──
async function refreshSessions() {
  try {
    const data = await api('/api/sessions')
    sessions = data.sessions || []
  } catch {
    sessions = []
  }
  renderSessionList()
}

function renderSessionList() {
  $('session-list').innerHTML = sessions.map((s) => `
    <div class="session-item${s.id === currentSessionId ? ' active' : ''}" data-id="${escapeHtml(s.id)}">
      <div class="session-title">${escapeHtml(s.title)}</div>
      <div class="session-time">${escapeHtml(relativeTime(s.updatedAt))}</div>
      <span class="activity-dot" data-dot="${escapeHtml(s.id)}"></span>
      <button class="session-delete" title="删除会话">✕</button>
    </div>`).join('')
}

async function createSession() {
  const data = await api('/api/sessions', { method: 'POST', body: JSON.stringify({}) })
  await refreshSessions()
  return data.id
}

async function switchSession(sessionId) {
  currentSessionId = sessionId
  localStorage.setItem('flutter_session_id', sessionId)
  renderSessionList()
  const view = getView(sessionId)
  showSession(sessionId)
  if (!view.loaded) {
    view.loaded = true
    await restoreHistory(sessionId, view)
  }
  inputEl.focus()
}

async function renameSession(sessionId, title) {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: JSON.stringify({ title }) })
  await refreshSessions()
}

async function deleteSession(sessionId) {
  const s = sessions.find((x) => x.id === sessionId)
  if (!confirm(`确定删除会话「${s?.title ?? sessionId}」？会话历史将一并删除。`)) return
  await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  views.delete(sessionId)
  await refreshSessions()
  if (sessionId === currentSessionId) {
    const next = sessions[0]?.id ?? (await createSession())
    await switchSession(next)
  }
}

$('session-list').addEventListener('click', (e) => {
  const item = e.target.closest('.session-item')
  if (!item) return
  if (e.target.closest('.session-delete')) { deleteSession(item.dataset.id); return }
  switchSession(item.dataset.id)
})

$('session-list').addEventListener('dblclick', (e) => {
  const item = e.target.closest('.session-item')
  if (item) startRename(item)
})

function startRename(item) {
  const id = item.dataset.id
  const titleEl = item.querySelector('.session-title')
  const old = titleEl.textContent
  titleEl.innerHTML = `<input class="rename-input" value="${escapeHtml(old)}">`
  const input = titleEl.querySelector('input')
  input.focus()
  input.select()
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur()
    if (e.key === 'Escape') { input.value = old; input.blur() }
  })
  input.addEventListener('blur', async () => {
    const v = input.value.trim()
    if (v && v !== old) await renameSession(id, v.slice(0, 60))
    else renderSessionList()
  }, { once: true })
}

$('new-session-btn').addEventListener('click', async () => {
  const id = await createSession()
  await switchSession(id)
})

// ── 活动圆点：非当前会话收到事件时点亮 3 秒 ──
const dotTimers = new Map()

function touchActivityDot(sessionId) {
  const dot = document.querySelector(`[data-dot="${CSS.escape(normalizeSessionId(sessionId))}"]`)
  if (!dot) return
  dot.classList.add('on')
  clearTimeout(dotTimers.get(sessionId))
  dotTimers.set(sessionId, setTimeout(() => dot.classList.remove('on'), 3000))
}

// ── Markdown 基础渲染 ──
function formatContent(text) {
  let html = escapeHtml(text)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\[截图\]\(screenshotId:([\w-]+)\)/g, '<img src="/api/screenshots/$1" alt="screenshot">')
  return html
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function appendUser(view, text) {
  const div = document.createElement('div')
  div.className = 'msg user'
  div.innerHTML = formatContent(text)
  view.el.appendChild(div)
  scrollBottom()
}

/** 新的 LLM 轮次：移除打字指示器，容器末尾新建助手消息元素。 */
function createTurn(view) {
  if (view.typingEl) { view.typingEl.remove(); view.typingEl = null }
  const el = document.createElement('div')
  el.className = 'msg assistant'
  view.el.appendChild(el)
  const turn = { el, buffer: '' }
  view.currentTurn = turn
  return turn
}

function setTyping(view, on) {
  if (on && !view.typingEl) {
    const el = document.createElement('div')
    el.className = 'msg assistant'
    el.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>'
    view.el.appendChild(el)
    view.typingEl = el
    scrollBottom()
  } else if (!on && view.typingEl) {
    view.typingEl.remove()
    view.typingEl = null
  }
}

function formatToolDetail(value) {
  if (value === undefined || value === null || value === '') return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > 500 ? text.slice(0, 500) + '…' : text
}

function renderToolCard(div, name, status, input, output, sourceBadge) {
  let html = `<div><span class="tool-name">${escapeHtml(name)}</span> ${sourceBadge || ''}<span class="tool-status">${escapeHtml(status)}</span></div>`
  const inputText = formatToolDetail(input)
  if (inputText) html += `<div class="tool-io"><div class="tool-io-label">输入</div><div class="tool-output">${escapeHtml(inputText)}</div></div>`
  const outputText = formatToolDetail(output)
  if (outputText) html += `<div class="tool-io"><div class="tool-io-label">输出</div><div class="tool-output">${escapeHtml(outputText)}</div></div>`
  div.innerHTML = html
  div.classList.toggle('compact', !showToolDetails)
}

/** 工具卡片：实时（tool_start）与历史还原共用。 */
function appendToolCard(view, callId, name, input, output, status) {
  const div = document.createElement('div')
  div.className = 'msg tool' + (showToolDetails ? '' : ' compact')
  // 输入保存在元素属性上：tool_end 重渲染状态与输出时保留输入区
  div._input = input ?? null
  renderToolCard(div, name, status, div._input, output)
  view.el.appendChild(div)
  if (callId) view.tools.set(callId, div)
  scrollBottom()
  return div
}

// ── 历史还原：首访会话时从服务端重建 ──
async function restoreHistory(sessionId, view) {
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
    const messages = data.messages || []
    const outputs = new Map()
    for (const m of messages) {
      if (m.role === 'tool' && m.callId) outputs.set(m.callId, m.content)
    }
    for (const m of messages) {
      if (m.role === 'user' && typeof m.content === 'string') {
        appendUser(view, m.content)
      } else if (m.role === 'assistant') {
        if (typeof m.content === 'string' && m.content.trim()) {
          const turn = createTurn(view)
          turn.buffer = m.content
          turn.el.innerHTML = formatContent(m.content)
        }
        if (Array.isArray(m.toolCalls)) {
          for (const call of m.toolCalls) {
            if (call.toolName === 'ask_user' || call.toolName === 'user_confirm') continue
            appendToolCard(view, call.callId, call.toolName, call.input, outputs.get(call.callId), '历史')
          }
        }
      } else if (m.role === 'tool' && (m.toolName === 'ask_user' || m.toolName === 'user_confirm')) {
        view.el.appendChild(renderAckedCard(m))
      }
    }
    scrollBottom()
  } catch {
    // 会话无历史或服务不可达
  }
}

// ── SSE：事件按 sessionId 路由到对应容器 ──
function routeEvent(event, seq, render) {
  if (!event.sessionId) return
  const sessionId = normalizeSessionId(event.sessionId)
  touchActivityDot(sessionId)
  const view = views.get(sessionId)
  if (!view) return
  if (seq > 0 && seq <= view.lastSeq) return // 断线重连重放去重
  if (seq > view.lastSeq) view.lastSeq = seq
  render(view)
  scrollBottom()
}

function sourceBadgeOf(data) {
  if (data.name === 'mobile_snapshot' && data.ok && typeof data.output === 'string') {
    try {
      const parsed = JSON.parse(data.output)
      if (parsed.source === 'companion') return '<span class="source-badge companion">Companion</span>'
      if (parsed.source === 'uiautomator') return '<span class="source-badge">uiautomator</span>'
    } catch { /* 输出可能被截断 */ }
  }
  return ''
}

function connectEvents() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`)

  es.addEventListener('tool_start', (e) => {
    const data = JSON.parse(e.data)
    routeEvent(data, Number(e.lastEventId), (view) => {
      appendToolCard(view, data.callId, data.name, data.input, null, '执行中…')
    })
  })

  es.addEventListener('tool_end', (e) => {
    const data = JSON.parse(e.data)
    routeEvent(data, Number(e.lastEventId), (view) => {
      const status = data.ok ? `完成 ${data.durationMs}ms` : `失败 ${data.durationMs}ms`
      const detail = data.ok ? data.output : data.error
      const card = data.callId ? view.tools.get(data.callId) : null
      if (card) {
        renderToolCard(card, data.name, status, card._input, detail, sourceBadgeOf(data))
      } else {
        appendToolCard(view, data.callId, data.name, null, detail, status)
      }
    })
  })

  es.addEventListener('llm_delta', (e) => {
    const data = JSON.parse(e.data)
    routeEvent(data, Number(e.lastEventId), (view) => {
      if (!data.turnId) return
      let turn = view.turns.get(data.turnId)
      if (!turn) {
        turn = createTurn(view)
        view.turns.set(data.turnId, turn)
      }
      if (data.content) {
        turn.buffer += data.content
        turn.el.innerHTML = formatContent(turn.buffer)
      }
    })
  })

  es.addEventListener('ask_user', (e) => {
    const data = JSON.parse(e.data)
    routeEvent(data, Number(e.lastEventId), (view) => {
      renderAskCard(view, data)
    })
  })

  es.onerror = () => {
    statusEl.textContent = running ? '思考中…（事件流重连中）' : '事件流重连中…'
  }
  es.onopen = () => {
    if (!running) statusEl.textContent = '就绪'
  }
}

// ── 问答 / 审批卡片（ask_user 事件）──
function renderAskCard(view, data) {
  const card = document.createElement('div')
  card.className = 'msg ask-card'
  const isApproval = data.kind === 'approval'
  const options = Array.isArray(data.options) ? data.options : []
  let optsHtml = ''
  if (data.select === 'single') {
    optsHtml = `<div class="ask-options single">${options.map((o) => `<button class="ask-opt" data-val="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div>`
  } else {
    optsHtml = `<div class="ask-options multi">${options.map((o) => `<label class="ask-chip"><input type="checkbox" value="${escapeHtml(o)}">${escapeHtml(o)}</label>`).join('')}</div>`
  }
  card.innerHTML = `
    <div class="ask-title">${isApproval ? '⚠️ 操作审批' : '❓ 需要你回答'}：${escapeHtml(data.question)}</div>
    ${optsHtml}
    <div class="ask-input-row"><input class="ask-input" type="text" placeholder="…或输入其他答案"></div>
    <button class="ask-submit">提交</button>`
  card._data = data
  view.el.appendChild(card)
  scrollBottom()
  // 单选：点选项立即提交
  card.querySelectorAll('.ask-opt').forEach((btn) => btn.addEventListener('click', () => {
    submitAnswer(view, card, btn.dataset.val)
  }))
  const submit = card.querySelector('.ask-submit')
  const input = card.querySelector('.ask-input')
  submit.addEventListener('click', () => {
    if (data.select === 'multiple') {
      const checked = Array.from(card.querySelectorAll('.ask-chip input:checked')).map((i) => i.value)
      const extra = input.value.trim()
      submitAnswer(view, card, extra ? [...checked, extra] : checked)
    } else {
      submitAnswer(view, card, input.value.trim() || (card.querySelector('.ask-opt.selected')?.dataset.val ?? ''))
    }
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit.click() })
}

function submitAnswer(view, card, answer) {
  const data = card._data
  card.querySelectorAll('button, input').forEach((el) => { el.disabled = true })
  fetch(`/api/sessions/${encodeURIComponent(normalizeSessionId(data.sessionId))}/asks/${encodeURIComponent(data.callId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ answer }),
  })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`) })
    .then(() => {
      card.classList.add('answered')
      const disp = Array.isArray(answer) ? answer.join(', ') : String(answer ?? '')
      card.querySelector('.ask-input-row')?.remove()
      card.querySelector('.ask-options')?.remove()
      card.querySelector('.ask-submit')?.remove()
      card.querySelector('.ask-title').textContent = `✅ 已${data.kind === 'approval' ? '审' : '答'}：${disp}`
    })
    .catch((err) => { alert('提交失败: ' + err.message) })
}

/** 历史还原：把 ask_user/user_confirm 的 tool 消息渲染成已答/已审摘要。 */
function renderAckedCard(m) {
  const div = document.createElement('div')
  div.className = 'msg ask-card answered'
  const content = m.content
  let summary = ''
  if (content && typeof content === 'object') {
    if (Array.isArray(content.answer)) summary = content.answer.join(', ')
    else if ('answer' in content) summary = String(content.answer)
    else if ('decision' in content) summary = String(content.decision)
    else if ('error' in content) summary = `(${String(content.error)})`
  }
  div.textContent = `📌 ${m.toolName === 'user_confirm' ? '已审' : '已答'}：${summary || '（无记录）'}`
  return div
}

// ── 发送与 run/continue 循环 ──
async function sendMessage(text) {
  if (running || !currentSessionId) return
  const sessionId = currentSessionId
  running = true
  stopRequested = false
  sendBtn.disabled = true
  stopBtn.classList.remove('hidden')
  statusEl.textContent = '思考中...'
  const view = getView(sessionId)
  appendUser(view, text)
  inputEl.value = ''
  inputEl.style.height = 'auto'
  setTyping(view, true)

  try {
    const body = {
      input: text,
      context: { timestamp: new Date().toISOString(), platform: 'android' },
      stepMode: true,
      ...(promptEl.value !== 'free-form' ? { promptName: promptEl.value } : {}),
    }
    let result = await fetch(`/v1/agent/sessions/${sessionId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }).then((r) => r.json())

    let stepCount = 0
    while (result.type === 'step_done') {
      if (stopRequested) break
      stepCount += 1
      statusEl.textContent = `思考中…（第 ${stepCount} 步）`
      result = await fetch(`/v1/agent/sessions/${sessionId}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          context: { timestamp: new Date().toISOString(), platform: 'android' },
          // 关键：continue 时必须带上 promptName，否则会回退到默认提示词
          ...(promptEl.value !== 'free-form' ? { promptName: promptEl.value } : {}),
        }),
      }).then((r) => r.json())
    }

    if (result.type === 'final') {
      const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)
      const turn = view.currentTurn ?? createTurn(view)
      if (output && output.trim()) {
        turn.el.innerHTML = formatContent(output)
      } else if (!turn.buffer) {
        turn.el.innerHTML = '<span style="color:var(--text2)">执行完成（模型未返回文字总结）。</span>'
      }
      maybeAutoTitle(sessionId, text)
    } else if (result.code) {
      const turn = view.currentTurn ?? createTurn(view)
      turn.el.className = 'msg assistant error'
      turn.el.textContent = `错误: ${result.message || result.code}`
    } else if (stopRequested) {
      const turn = view.currentTurn ?? createTurn(view)
      if (!turn.buffer) turn.el.innerHTML = '<span style="color:var(--text2)">已停止。</span>'
    }
  } catch (err) {
    const turn = view.currentTurn ?? createTurn(view)
    turn.el.className = 'msg assistant error'
    turn.el.textContent = `请求失败: ${err.message}`
  } finally {
    setTyping(view, false)
    running = false
    stopRequested = false
    sendBtn.disabled = false
    stopBtn.classList.add('hidden')
    statusEl.textContent = '就绪'
    inputEl.focus()
  }
}

/** 首条消息后把「新会话」占位标题替换为消息摘要。 */
async function maybeAutoTitle(sessionId, firstMessage) {
  const s = sessions.find((x) => x.id === sessionId)
  if (!s || s.title !== '新会话') return
  try {
    await renameSession(sessionId, firstMessage.slice(0, 30))
  } catch {
    // 命名失败不影响会话
  }
}

// ── 输入区 ──
sendBtn.addEventListener('click', () => {
  const text = inputEl.value.trim()
  if (text) sendMessage(text)
})

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const text = inputEl.value.trim()
    if (text) sendMessage(text)
  }
})

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto'
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'
})

stopBtn.addEventListener('click', () => { stopRequested = true })

$('docs-btn').addEventListener('click', () => {
  window.open('guide.html', '_blank', 'noopener')
})

// ── 一键复制上下文：服务端导出完整 Markdown，与显示开关无关 ──
$('copy-context-btn').addEventListener('click', async () => {
  const btn = $('copy-context-btn')
  try {
    const limit = localStorage.getItem('copy_tool_output_limit') ?? '20000'
    const res = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/export?toolOutputLimit=${limit}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await navigator.clipboard.writeText(await res.text())
    const old = btn.textContent
    btn.textContent = '✓'
    setTimeout(() => { btn.textContent = old }, 1500)
  } catch (e) {
    alert('复制失败: ' + e.message)
  }
})

// ── 设置面板 ──
const settingsOverlay = $('settings-overlay')
const showToolDetailsEl = $('setting-show-tool-details')
const themeEl = $('setting-theme')
const copyLimitEl = $('setting-copy-limit')
const trustedHostEl = $('setting-trusted-host')

showToolDetailsEl.checked = showToolDetails
themeEl.value = localStorage.getItem('theme') || 'dark'
copyLimitEl.value = localStorage.getItem('copy_tool_output_limit') ?? '20000'

async function loadTrustedHost() {
  if (!currentSessionId) return
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(currentSessionId)}/settings`)
    trustedHostEl.checked = !!data.trustedHost
  } catch { /* 默认关 */ }
}
trustedHostEl.addEventListener('change', async () => {
  if (!currentSessionId) return
  await api(`/api/sessions/${encodeURIComponent(currentSessionId)}/settings`, {
    method: 'POST', body: JSON.stringify({ trustedHost: trustedHostEl.checked }),
  }).catch(() => {})
})

// 全局当前工作区：载入回显，保存 PATCH 到服务端
const workspaceInputEl = $('setting-workspace')
async function loadWorkspace() {
  try {
    const data = await api('/api/workspace')
    workspaceInputEl.value = data.workspace || ''
  } catch { /* 忽略 */ }
}
$('setting-workspace-save').addEventListener('click', async () => {
  const ws = workspaceInputEl.value.trim()
  if (!ws) return
  await api('/api/workspace', { method: 'POST', body: JSON.stringify({ workspace: ws }) }).catch(() => {})
})

function applyToolDetailSetting() {
  for (const view of views.values()) {
    view.el.querySelectorAll('.msg.tool').forEach((el) => el.classList.toggle('compact', !showToolDetails))
  }
}

$('settings-btn').addEventListener('click', () => settingsOverlay.classList.add('open'))
$('settings-close').addEventListener('click', () => settingsOverlay.classList.remove('open'))
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('open')
})

showToolDetailsEl.addEventListener('change', () => {
  showToolDetails = showToolDetailsEl.checked
  localStorage.setItem('show_tool_details', showToolDetails ? '1' : '0')
  applyToolDetailSetting()
})

themeEl.addEventListener('change', () => {
  document.documentElement.dataset.theme = themeEl.value
  localStorage.setItem('theme', themeEl.value)
})

copyLimitEl.addEventListener('change', () => {
  localStorage.setItem('copy_tool_output_limit', copyLimitEl.value)
})

// ── Skills 面板（自旧版 index.html 迁移，逻辑不变） ──
const skillsOverlay = $('skills-overlay')
const skillsBtn = $('skills-btn')
const skillsClose = $('skills-close')
const skillsContent = $('skills-content')
let currentSkillSlug = null

skillsBtn.addEventListener('click', () => { skillsOverlay.classList.add('open'); renderSkillList(); })
skillsClose.addEventListener('click', () => { skillsOverlay.classList.remove('open'); currentSkillSlug = null; })
skillsOverlay.addEventListener('click', (e) => {
  if (e.target === skillsOverlay) { skillsOverlay.classList.remove('open'); currentSkillSlug = null; }
})

document.querySelectorAll('#skills-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#skills-tabs .tab').forEach((t) => t.classList.remove('active'))
    tab.classList.add('active')
    const t = tab.getAttribute('data-tab')
    if (t === 'history') renderHistory()
    else renderSkillList()
  })
})

async function renderSkillList() {
  skillsContent.innerHTML = '<div class="generating">加载中…</div>'
  let skills = []
  try {
    const data = await api('/api/skills')
    skills = data.skills || []
  } catch (e) {
    skillsContent.innerHTML = `<div class="empty-state">加载失败：${escapeHtml(e.message)}</div>`
    return
  }
  let html = `
    <button class="btn-primary" id="new-skill-btn" style="padding:10px;border:none;border-radius:6px;cursor:pointer;font-size:13px;">+ 用大白话新建 Skill</button>
    <div style="height:8px"></div>`
  if (skills.length === 0) {
    html += `<div class="empty-state">还没有 Skill。<br>点上面的按钮，用大白话描述你想做的事，LLM 会帮你生成。</div>`
  } else {
    for (const s of skills) {
      html += `<div class="skill-card" data-slug="${escapeHtml(s.slug)}">
        <div class="skill-name">${escapeHtml(s.meta.name)}</div>
        <div class="skill-desc">${escapeHtml(s.meta.description || '无描述')}</div>
        <div class="skill-meta">
          <span>v${escapeHtml(s.meta.version)}</span>
          <span>${escapeHtml((s.meta.updatedAt || '').slice(0, 10))}</span>
        </div>
      </div>`
    }
  }
  skillsContent.innerHTML = html
  document.getElementById('new-skill-btn')?.addEventListener('click', renderNewSkillForm)
  skillsContent.querySelectorAll('.skill-card').forEach((card) => {
    card.addEventListener('click', () => renderSkillDetail(card.dataset.slug))
  })
}

function renderNewSkillForm() {
  skillsContent.innerHTML = `
    <button class="back" id="back-to-list">← 返回列表</button>
    <form id="new-skill-form">
      <h3>用大白话描述你想做什么</h3>
      <textarea id="intent-input" placeholder="例如：打开真实场景 Demo，用账号 13800138000 密码 test123 登录，验证码填 123456，进入第一个订单，打开帮助中心，在 H5 页面用 e2e_user / pass1234 登录"></textarea>
      <div id="generate-status"></div>
      <div class="form-actions">
        <button type="button" class="btn-secondary" id="cancel-skill-gen" style="padding:10px;border-radius:8px;cursor:pointer;font-size:14px;">取消</button>
        <button type="submit" class="btn-primary" id="generate-btn" style="padding:10px;border:none;border-radius:8px;cursor:pointer;font-size:14px;">生成 Skill</button>
      </div>
    </form>`
  document.getElementById('back-to-list').addEventListener('click', renderSkillList)
  document.getElementById('cancel-skill-gen').addEventListener('click', renderSkillList)
  document.getElementById('new-skill-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const intent = document.getElementById('intent-input').value.trim()
    if (!intent) return
    const statusEl = document.getElementById('generate-status')
    statusEl.innerHTML = '<div class="generating">LLM 正在生成，请稍候…</div>'
    document.getElementById('generate-btn').disabled = true
    try {
      const generated = await api('/api/skills/generate', { method: 'POST', body: JSON.stringify({ intent }) })
      renderSkillEdit(generated, true)
    } catch (e) {
      statusEl.innerHTML = `<div style="color:var(--error);font-size:12px;">生成失败：${escapeHtml(e.message)}</div>`
      document.getElementById('generate-btn').disabled = false
    }
  })
}

function renderSkillEdit(skill, isNew) {
  skillsContent.innerHTML = `
    <button class="back" id="back-to-list">← 返回列表</button>
    <h3 style="font-size:14px;margin:4px 0">${isNew ? '核验并保存 Skill' : '编辑 Skill'}</h3>
    <form id="skill-form">
      <label>名称（英文 kebab-case，用于目录名）</label>
      <input name="name" value="${escapeHtml(skill.slug)}" />
      <label>描述</label>
      <input name="description" value="${escapeHtml(skill.meta.description || '')}" />
      <label>系统提示词（可编辑）</label>
      <textarea name="prompt">${escapeHtml(skill.prompt)}</textarea>
      <div class="form-actions">
        <button type="button" class="btn-secondary" id="cancel-skill" style="padding:8px;border-radius:6px;cursor:pointer;">取消</button>
        <button type="submit" class="btn-primary" style="padding:8px;border:none;border-radius:6px;cursor:pointer;">${isNew ? '保存 Skill' : '更新'}</button>
      </div>
    </form>`
  document.getElementById('back-to-list').addEventListener('click', renderSkillList)
  document.getElementById('cancel-skill').addEventListener('click', renderSkillList)
  document.getElementById('skill-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    const payload = {
      name: fd.get('name'),
      description: fd.get('description'),
      prompt: fd.get('prompt'),
    }
    const slug = fd.get('name')
    try {
      await api(`/api/skills/${encodeURIComponent(slug)}`, { method: 'POST', body: JSON.stringify(payload) })
      renderSkillList()
    } catch (err) {
      alert('保存失败：' + err.message)
    }
  })
}

async function renderHistory() {
  skillsContent.innerHTML = '<div class="generating">加载中…</div>'
  try {
    const data = await api('/api/history')
    if (!data.runs || data.runs.length === 0) {
      skillsContent.innerHTML = `<div class="empty-state">暂无执行记录。<br>创建并执行一个 Skill 后，这里会显示历史。</div>`
      return
    }
    skillsContent.innerHTML = data.runs.map((r) => `
      <div class="run-item" style="cursor:pointer" onclick="renderSkillDetail('${r.slug}')">
        <div><span class="run-status ${r.status}">${escapeHtml(r.status)}</span> ${escapeHtml(r.meta.name)}</div>
        <div class="run-time">${r.startedAt} ${r.summary ? '- ' + escapeHtml(r.summary.slice(0, 80)) : ''}</div>
      </div>
    `).join('')
  } catch (e) {
    skillsContent.innerHTML = `<div class="empty-state">加载失败：${escapeHtml(e.message)}</div>`
  }
}

async function renderSkillDetail(slug) {
  currentSkillSlug = slug
  skillsContent.innerHTML = '<div class="generating">加载中…</div>'
  let skill
  try {
    skill = await api(`/api/skills/${encodeURIComponent(slug)}`)
  } catch (e) {
    skillsContent.innerHTML = `<div class="empty-state">加载失败：${escapeHtml(e.message)}</div>`
    return
  }
  const runsHtml = (skill.runs || []).length === 0
    ? '<div style="color:var(--text2);font-size:12px;">暂无执行记录</div>'
    : `<div class="runs-list">${skill.runs.map((r) => `
        <div class="run-item">
          <div class="run-status ${r.status}">${r.status === 'completed' ? '✓ 成功' : r.status === 'failed' ? '✗ 失败' : r.status}</div>
          <div class="run-time">${escapeHtml((r.finishedAt || r.startedAt || '').replace('T', ' ').slice(0, 19))}</div>
          ${r.summary ? `<div style="font-size:12px;margin-top:4px;">${escapeHtml(r.summary)}</div>` : ''}
        </div>`).join('')}</div>`
  skillsContent.innerHTML = `
    <button class="back" id="back-to-list">← 返回列表</button>
    <div class="skill-detail">
      <h3 style="font-size:15px;">${escapeHtml(skill.meta.name)}</h3>
      <div style="color:var(--text2);font-size:12px;">${escapeHtml(skill.meta.description || '')}</div>
      <div style="color:var(--text2);font-size:11px;">v${escapeHtml(skill.meta.version)} · ${escapeHtml((skill.meta.tools || []).join(', '))}</div>
      <button class="btn-primary" id="run-skill-btn" style="padding:10px;border:none;border-radius:6px;cursor:pointer;font-weight:600;">▶ 一键执行</button>
      <button class="btn-secondary" id="optimize-skill-btn" style="padding:6px;border-radius:6px;cursor:pointer;margin-top:6px;align-self:flex-start;">⟳ 优化 Skill</button>
      <div>
        <strong style="font-size:12px;">系统提示词</strong>
        <pre>${escapeHtml(skill.prompt)}</pre>
      </div>
      <div>
        <strong style="font-size:12px;">执行历史</strong>
        ${runsHtml}
      </div>
      <button class="btn-danger" id="delete-skill-btn" style="padding:6px;border-radius:6px;cursor:pointer;margin-top:8px;align-self:flex-start;">删除 Skill</button>
    </div>`
  document.getElementById('back-to-list').addEventListener('click', renderSkillList)
  document.getElementById('run-skill-btn').addEventListener('click', () => runSkill(slug, skill.meta.name))
  document.getElementById('optimize-skill-btn').addEventListener('click', async () => {
    const btn = document.getElementById('optimize-skill-btn')
    btn.textContent = '优化中…'
    btn.disabled = true
    try {
      const result = await api(`/api/skills/${encodeURIComponent(slug)}/optimize`, { method: 'POST' })
      if (!confirm(`优化分析：${result.analysis}\n\n新版本：${result.version}\n\n是否保存新提示词？\n\n${result.prompt.slice(0, 300)}…`)) return
      await api(`/api/skills/${encodeURIComponent(slug)}/apply`, {
        method: 'POST',
        body: JSON.stringify({ prompt: result.prompt, version: result.version }),
      })
      renderSkillDetail(slug)
    } catch (e) {
      alert('优化失败: ' + e.message)
    } finally {
      btn.textContent = '⟳ 优化 Skill'
      btn.disabled = false
    }
  })
  document.getElementById('delete-skill-btn').addEventListener('click', async () => {
    if (!confirm(`确定删除 Skill「${skill.meta.name}」？`)) return
    await api(`/api/skills/${encodeURIComponent(slug)}`, { method: 'DELETE' })
    renderSkillList()
  })
}

async function runSkill(slug, name) {
  skillsOverlay.classList.remove('open')
  const skillPromptName = 'skill-' + slug
  if (!Array.from(promptEl.options).some((o) => o.value === skillPromptName)) {
    const opt = document.createElement('option')
    opt.value = skillPromptName
    opt.textContent = 'Skill: ' + name
    promptEl.appendChild(opt)
  }
  promptEl.value = skillPromptName
  inputEl.value = '开始执行'
  sendMessage('开始执行')
}

// ── 启动：加载会话 + 旧数据迁移 ──
/** 旧版只把会话 ID 存 localStorage，服务端无记录；有历史则补建。 */
async function migrateLegacySession(legacyId) {
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(legacyId)}/messages`)
    const firstUser = (data.messages || []).find((m) => m.role === 'user' && typeof m.content === 'string')
    if (!firstUser) return null
    await api('/api/sessions', { method: 'POST', body: JSON.stringify({ id: legacyId, title: firstUser.content.slice(0, 30) }) })
    await refreshSessions()
    return legacyId
  } catch {
    return null
  }
}

// ── 会话边栏：拖拽调宽 + 收起/展开 ──
const sidebar = $('sidebar')
const sidebarToggle = $('sidebar-toggle')
const sidebarResize = $('sidebar-resize')
const SIDEBAR_MIN_W = 160

/** 读回上次宽度并钳制到 [MIN, 屏宽一半]，超限部分回退默认。 */
function applySidebarWidth() {
  const max = Math.floor(window.innerWidth / 2)
  const saved = parseFloat(localStorage.getItem('sidebar_width'))
  const w = !Number.isNaN(saved) && saved >= SIDEBAR_MIN_W ? Math.max(SIDEBAR_MIN_W, Math.min(max, saved)) : 240
  sidebar.style.setProperty('--sidebar-w', `${Math.min(w, max)}px`)
  return w
}

function applySidebarCollapsed() {
  const collapsed = localStorage.getItem('sidebar_collapsed') === '1'
  sidebar.classList.toggle('collapsed', collapsed)
  sidebarToggle.textContent = collapsed ? '»' : '«'
  sidebarToggle.title = collapsed ? '展开会话列表' : '收起会话列表'
}

sidebarToggle.addEventListener('click', () => {
  const collapsed = !sidebar.classList.contains('collapsed')
  sidebar.classList.toggle('collapsed', collapsed)
  localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0')
  applySidebarCollapsed()
})

sidebarResize.addEventListener('pointerdown', (e) => {
  if (sidebar.classList.contains('collapsed')) return
  e.preventDefault()
  sidebar.classList.add('resizing')
  document.body.style.cursor = 'col-resize'
  const startX = e.clientX
  const startW = sidebar.offsetWidth
  const max = Math.floor(window.innerWidth / 2)
  const move = (ev) => {
    const w = Math.max(SIDEBAR_MIN_W, Math.min(max, startW + (ev.clientX - startX)))
    sidebar.style.setProperty('--sidebar-w', `${w}px`)
  }
  const up = () => {
    sidebar.classList.remove('resizing')
    document.body.style.cursor = ''
    localStorage.setItem('sidebar_width', sidebar.offsetWidth.toString())
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
})

window.addEventListener('resize', () => { applySidebarWidth() })

async function init() {
  applySidebarWidth()
  applySidebarCollapsed()
  await refreshSessions()
  const legacy = localStorage.getItem('flutter_session_id')
  let target = null
  if (legacy && sessions.some((s) => s.id === legacy)) {
    target = legacy
  } else if (legacy) {
    target = await migrateLegacySession(legacy)
  }
  if (!target) target = sessions[0]?.id ?? (await createSession())
  await switchSession(target)
  loadTrustedHost()
  loadWorkspace()
  connectEvents()
}

init()
