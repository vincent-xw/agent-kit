<script setup lang="ts">
import { onMounted } from 'vue'
import { useConversation } from '../composables/useConversation'
import { renderMarkdown, stepSummary } from '../utils'
import { TOOLS_CATALOG } from '../utils'
import {
  ArrowDown, Delete, QuestionFilled, Star, CopyDocument,
  FolderOpened, Paperclip, Picture, Document, Upload,
} from '@element-plus/icons-vue'

const {
  instruction, turns, currentSteps, sessions, sessionId,
  isBusy, isPlanning, canSubmit, canSaveSkill, sessionIndex,
  pendingPlan, planReasoning, runState, runError, isStopping,
  allFiles, fileManagerVisible, fileInputRef,
  screenshotPreviewVisible, previewingScreenshot,
  toolsHelpVisible, toolsHelpAcknowledged,
  attachments,
  requestPlan, confirmPlan, rejectPlan, stop,
  startNewSession, handleSessionCommand, handleDeleteSession,
  turnFiles, downloadFile, openFileManager, triggerFilePicker,
  handleFileSelect, handleRemoveFile, handleClearAllFiles,
  previewScreenshot, handleSaveSkill,
  acknowledgeToolsHelp,
  copyTurnText, copyStepDetail, copyDiagnosticLog,
  init,
} = useConversation()

onMounted(init)
</script>

<template>
  <el-card shadow="never">
    <template #header>
      <div class="panel-header">
        <div class="title-row">
          <el-text tag="b">自由指令</el-text>
          <!-- 工具能力说明：popup 浮层，点击 ? 触发；首次自动弹出由 v-model 控制 -->
          <el-popover
            v-model:visible="toolsHelpVisible"
            placement="bottom-start"
            :width="520"
            trigger="click"
            popper-class="tools-help-popover"
          >
            <template #reference>
              <el-icon class="help-icon" title="查看可用工具与操作边界"><QuestionFilled /></el-icon>
            </template>
            <div class="tools-help">
              <el-text size="small" type="info">
                你的指令会触发以下工具。文件操作在 BFF 服务端执行，页面操作通过浏览器扩展执行。
              </el-text>
              <div v-for="tool in TOOLS_CATALOG" :key="tool.name" class="tool-item">
                <div class="tool-header">
                  <el-text size="small" tag="b">{{ tool.title }}</el-text>
                  <el-tag size="small" :type="tool.category === 'write' ? 'warning' : 'info'" effect="plain">
                    {{ tool.category === 'write' ? '写' : '读' }}
                  </el-tag>
                </div>
                <el-text size="small" type="info">{{ tool.description }}</el-text>
              </div>
            </div>
          </el-popover>
        </div>
        <el-space>
          <!-- 会话列表：切回旧会话继续多轮上下文。sessionId 是 BFF 侧历史的钥匙。 -->
          <el-dropdown v-if="sessions.length" trigger="click" @command="handleSessionCommand">
            <el-button link size="small" :disabled="isBusy">
              会话 {{ sessionIndex }}
              <el-icon class="el-icon--right"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="(session, index) in sessions"
                  :key="session.id"
                  :command="session.id"
                  :disabled="session.id === sessionId"
                >
                  <span class="session-item">
                    <span class="session-title">{{ session.title }}</span>
                    <el-icon class="session-delete" @click.stop="handleDeleteSession(session.id)"><Delete /></el-icon>
                  </span>
                </el-dropdown-item>
                <el-dropdown-item divided :command="'__new__'" :disabled="isBusy">＋ 新会话</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button v-else link size="small" :disabled="isBusy" @click="startNewSession">新会话</el-button>
        </el-space>
      </div>
    </template>

    <el-space direction="vertical" fill :size="10" style="width: 100%; flex: 1; min-height: 0; overflow: hidden">

<!-- 对话记录：多轮上下文让「点第三条结果」这类指代成立 -->
      <div v-if="turns.length" class="conversation">
        <div v-for="(turn, index) in turns" :key="index" :class="['turn', `turn-${turn.role}`]">
          <div class="turn-header">
            <el-text size="small" tag="b">{{ turn.role === 'user' ? '你' : turn.role === 'agent' ? 'Agent' : '错误' }}</el-text>
            <el-button v-if="turn.text" link size="small" class="copy-btn" @click="copyTurnText(turn.text, index)">
              <el-icon><CopyDocument /></el-icon>
            </el-button>
            <el-button
              v-if="turn.role === 'error'"
              link
              size="small"
              class="copy-btn"
              @click="copyDiagnosticLog(turn)"
            >
              复制诊断日志
            </el-button>
          </div>
          <div v-if="turn.role === 'agent'" class="turn-text markdown-body" v-html="renderMarkdown(turn.text)"></div>
          <div v-else class="turn-text">{{ turn.text }}</div>
          <div v-if="turn.role === 'agent' && turnFiles(turn).length" class="turn-files">
            <div v-for="file in turnFiles(turn)" :key="file.id" class="turn-file">
              <img
                v-if="file.isImage"
                :src="file.url"
                class="turn-file-thumb"
                :alt="file.filename"
                @click="previewScreenshot(file)"
              />
              <el-icon v-else class="turn-file-icon"><Document /></el-icon>
              <div class="turn-file-info">
                <el-text size="small" truncated>{{ file.filename }}</el-text>
                <el-text size="small" type="info">{{ (file.size / 1024).toFixed(1) }}KB</el-text>
              </div>
              <el-button link size="small" @click="downloadFile(file)">下载</el-button>
            </div>
          </div>
          <el-collapse v-if="turn.steps?.length" class="turn-steps">
            <el-collapse-item :title="`执行了 ${turn.steps.length} 步`" :name="index">
              <div v-for="step in turn.steps" :key="step.step" class="step-row">
                <el-tag size="small" effect="plain">{{ step.step }}</el-tag>
                <el-text size="small">{{ step.toolName }}</el-text>
                <el-tag size="small" :type="stepSummary(step.output).type" effect="plain">
                  {{ stepSummary(step.output).text }}
                </el-tag>
                <el-button :icon="CopyDocument" link size="small" class="step-copy" @click="copyStepDetail(step)" />
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </div>

      <!-- 执行中的实时步骤 -->
      <div v-if="isBusy && currentSteps.length" class="live-steps">
        <el-text size="small" type="info">正在执行第 {{ currentSteps.length }} 步…</el-text>
        <div v-for="step in currentSteps.slice(-3)" :key="step.step" class="step-row">
          <el-tag size="small" effect="plain">{{ step.step }}</el-tag>
          <el-text size="small">{{ step.toolName }}</el-text>
          <el-tag size="small" :type="stepSummary(step.output).type" effect="plain">
            {{ stepSummary(step.output).text }}
          </el-tag>
          <el-button :icon="CopyDocument" link size="small" class="step-copy" @click="copyStepDetail(step)" />
        </div>
      </div>

      <!-- 已勾选带入上下文的附件 -->
      <div v-if="attachments.selectedCount() > 0" class="attached-chips">
        <el-tag
          v-for="file in allFiles.filter((f) => attachments.isSelected(f.id))"
          :key="file.id"
          size="small"
          closable
          @close="attachments.toggle(file.id)"
        >
          <el-icon v-if="file.isImage" class="chip-icon"><Picture /></el-icon>
          <el-icon v-else class="chip-icon"><Document /></el-icon>
          {{ file.filename }}
        </el-tag>
      </div>

      <div class="input-toolbar">
        <el-button :icon="Paperclip" link @click="openFileManager" title="附件与文件管理">
          {{ attachments.selectedCount() > 0 ? `附件（${attachments.selectedCount()}）` : '附件' }}
        </el-button>
      </div>
      <el-input
        v-model="instruction"
        type="textarea"
        :rows="3"
        resize="none"
        :disabled="isBusy"
        placeholder="用一句话描述你想做什么，例如：在搜索框输入 Vue3 并搜索"
        @keydown.enter.meta.prevent="requestPlan"
      />
      <input
        ref="fileInputRef"
        type="file"
        multiple
        accept=".txt,.csv,.json,.md,.xml,.html,.js,.ts,.py,.yaml,.yml,text/*"
        style="display: none"
        @change="handleFileSelect"
      />

      <!-- 文件管理弹窗 -->
      <el-dialog v-model="fileManagerVisible" title="附件与文件管理" width="640px" append-to-body>
        <template #header>
          <div class="fm-header">
            <span>附件与文件管理</span>
            <el-button :icon="Upload" link size="small" @click="triggerFilePicker">上传文件</el-button>
          </div>
        </template>
        <div v-if="!allFiles.length" class="fm-empty">
          还没有文件。agent 生成的截图、导出的文件会出现在这里；也可以点右上角上传。
        </div>
        <div v-else class="fm-list">
          <div v-for="file in allFiles" :key="file.id" class="fm-item">
            <el-checkbox
              :model-value="attachments.isSelected(file.id)"
              @change="attachments.toggle(file.id)"
            >
              <span class="fm-name">
                <el-icon v-if="file.isImage" class="fm-icon"><Picture /></el-icon>
                <el-icon v-else class="fm-icon"><Document /></el-icon>
                {{ file.filename }}
              </span>
            </el-checkbox>
            <div class="fm-meta">
              <el-text size="small" type="info">
                {{ file.isImage ? `${file.width}x${file.height} · ` : '' }}{{ (file.size / 1024).toFixed(1) }}KB
              </el-text>
              <el-button
                v-if="file.isImage"
                link size="small"
                @click="previewScreenshot(file)"
              >预览</el-button>
              <el-button link size="small" @click="downloadFile(file)">下载</el-button>
              <el-button :icon="Delete" link size="small" @click="handleRemoveFile(file.id)" />
            </div>
          </div>
        </div>
        <template #footer>
          <el-button @click="handleClearAllFiles" plain type="danger">清空全部</el-button>
          <el-button type="primary" @click="fileManagerVisible = false">完成</el-button>
        </template>
      </el-dialog>

      <!-- 截图大图预览 -->
      <el-dialog
        v-model="screenshotPreviewVisible"
        title="截图预览"
        width="95%"
        :close-on-click-modal="true"
        append-to-body
      >
        <img v-if="previewingScreenshot" :src="previewingScreenshot.url" style="width: 100%; max-height: 70vh; object-fit: contain" />
      </el-dialog>

      <el-space wrap>
        <el-button type="primary" :loading="isPlanning" :disabled="!canSubmit" @click="requestPlan">
          {{ isPlanning ? '评估中...' : '评估' }}
        </el-button>
        <el-button v-if="isBusy && !isPlanning" type="danger" plain :loading="isStopping" @click="stop">停止</el-button>
        <el-button :icon="Star" :disabled="!canSaveSkill" plain @click="handleSaveSkill">
          保存为技能
        </el-button>
        <el-text size="small" type="info">⌘ + Enter 快速评估</el-text>
      </el-space>

      <!-- 计划预览：模型评估完成后展示，等用户确认或取消 -->
      <el-card v-if="pendingPlan" shadow="never" class="plan-card">
        <template #header>
          <div class="plan-header">
            <el-text tag="b">任务评估</el-text>
            <el-tag :type="pendingPlan.feasible ? 'success' : 'danger'" effect="plain" size="small">
              {{ pendingPlan.feasible ? '可行' : '不可行' }}
            </el-tag>
            <el-tag v-if="pendingPlan.feasible" :type="pendingPlan.confidence === 'high' ? 'success' : pendingPlan.confidence === 'medium' ? 'warning' : 'danger'" effect="plain" size="small">
              置信度：{{ pendingPlan.confidence === 'high' ? '高' : pendingPlan.confidence === 'medium' ? '中' : '低' }}
            </el-tag>
          </div>
        </template>

        <el-text size="small">{{ pendingPlan.summary }}</el-text>

        <!-- 模型思考链（reasoning_content）：可折叠 -->
        <el-collapse v-if="planReasoning" class="plan-reasoning">
          <el-collapse-item title="模型思考过程">
            <pre class="reasoning-text">{{ planReasoning }}</pre>
          </el-collapse-item>
        </el-collapse>

        <!-- 步骤列表 -->
        <div v-if="pendingPlan.steps.length" class="plan-steps">
          <div v-for="(step, index) in pendingPlan.steps" :key="index" class="plan-step">
            <el-text size="small" tag="b">{{ index + 1 }}.</el-text>
            <el-text size="small">{{ step.action }}</el-text>
            <el-tag size="small" :type="step.write ? 'warning' : 'info'" effect="plain">{{ step.tool }}</el-tag>
            <el-text v-if="step.note" size="small" type="warning">{{ step.note }}</el-text>
          </div>
        </div>

        <!-- 风险 -->
        <el-alert v-if="pendingPlan.risks.length" type="warning" :closable="false" show-icon :title="`风险：${pendingPlan.risks.join('；')}`" />

        <!-- 做不到的部分 -->
        <el-alert v-if="pendingPlan.cannotDo.length" type="error" :closable="false" show-icon :title="`无法完成：${pendingPlan.cannotDo.join('；')}`" />

        <!-- 确认/取消按钮 -->
        <div v-if="pendingPlan.feasible" class="plan-actions">
          <el-button type="primary" @click="confirmPlan">确认执行</el-button>
          <el-button @click="rejectPlan">取消</el-button>
        </div>
        <div v-else class="plan-actions">
          <el-button @click="rejectPlan">知道了</el-button>
        </div>
      </el-card>

      <el-alert
        v-if="runError && runState === 'failed'"
        :title="runError.message"
        :description="runError.details"
        type="error"
        :closable="false"
        show-icon
      />
    </el-space>

  </el-card>
</template>
<style scoped>
.title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.help-icon {
  cursor: pointer;
  color: var(--el-text-color-secondary);
  font-size: 16px;
}

.help-icon:hover {
  color: var(--el-color-primary);
}

.tools-help {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}

.tool-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.tool-item:last-child {
  border-bottom: none;
}

.tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tool-header .el-text {
  flex: 1;
}

.tools-help-actions {
  display: flex;
  justify-content: center;
  padding-top: 8px;
  margin-top: 4px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 160px;
}

.session-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.session-delete {
  color: var(--el-color-danger);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.page-context {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}

.url-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
}

.permission-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.conversation {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.turn {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
  min-width: 0;
  overflow: hidden;
}

.turn-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.copy-btn {
  opacity: 0;
  transition: opacity 0.2s;
}

.turn:hover .copy-btn {
  opacity: 1;
}

.turn-user {
  background: var(--el-color-primary-light-9);
}

.turn-error {
  background: var(--el-color-danger-light-9);
}

.turn-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  margin-top: 2px;
  overflow-wrap: anywhere;
  min-width: 0;
}

/* Markdown 渲染样式 */
.markdown-body {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* Markdown 渲染样式 */
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 8px 0 4px;
  font-size: 14px;
  font-weight: 600;
}

.markdown-body :deep(h1) { font-size: 16px; }
.markdown-body :deep(h2) { font-size: 15px; }

.markdown-body :deep(p) {
  margin: 4px 0;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 4px 0;
  padding-left: 20px;
}

.markdown-body :deep(li) {
  margin: 2px 0;
}

.markdown-body :deep(code) {
  background: var(--el-fill-color-dark);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
  font-family: monospace;
}

.markdown-body :deep(pre) {
  background: var(--el-fill-color-dark);
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
  max-width: 100%;
  margin: 4px 0;
}

.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
}

.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--el-border-color);
  padding-left: 10px;
  margin: 4px 0;
  color: var(--el-text-color-secondary);
}

.markdown-body :deep(a) {
  color: var(--el-color-primary);
  text-decoration: none;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 4px 0;
  display: block;
  overflow-x: auto;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--el-border-color);
  padding: 4px 8px;
  font-size: 12px;
}

.markdown-body :deep(strong) {
  font-weight: 600;
}

.turn-steps {
  margin-top: 6px;
}

.turn-files {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.turn-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-blank);
}
.turn-file-thumb {
  width: 48px;
  height: 36px;
  object-fit: cover;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}
.turn-file-icon {
  font-size: 20px;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}
.turn-file-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.step-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
}
.step-copy {
  flex-shrink: 0;
  margin-left: auto;
}

.live-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: var(--el-color-info-light-9);
  border-radius: 4px;
  flex-shrink: 0;
}

.plan-card {
  border: 1px solid var(--el-color-primary-light-5);
}

.plan-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plan-reasoning {
  margin: 8px 0;
}

.reasoning-text {
  margin: 0;
  padding: 8px;
  background: var(--el-fill-color-lighter);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-secondary);
}

.plan-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
}

.plan-step {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.plan-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}

.input-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.input-toolbar .el-button {
  margin-left: 0;
  padding-left: 4px;
}

.attached-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.chip-icon {
  margin-right: 2px;
  vertical-align: -2px;
}

.fm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.fm-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.fm-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 50vh;
  overflow-y: auto;
}
.fm-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 4px;
  border-radius: 4px;
}
.fm-item:hover {
  background: var(--el-fill-color-light);
}
.fm-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fm-icon {
  flex-shrink: 0;
}
.fm-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
</style>

