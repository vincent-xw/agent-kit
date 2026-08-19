package com.agentkit.companion

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * 持有当前窗口的无障碍节点树引用，供 HTTP 服务器查询。
 * 每次 TYPE_WINDOW_CONTENT_CHANGED 或 TYPE_WINDOW_STATE_CHANGED
 * 事件时更新 rootInActiveWindow 的引用。
 */
class CompanionAccessibilityService : AccessibilityService() {

    companion object {
        /** 服务实例，供 HttpServer 访问节点树。 */
        var instance: CompanionAccessibilityService? = null
            private set

        /** 事件环形缓冲，最近 200 条。 */
        private val eventBuffer = ConcurrentLinkedQueue<AccessibilityEvent>()
        private const val MAX_EVENTS = 200
    }

    /** 当前活跃窗口的根节点。 */
    private var currentRoot: AccessibilityNodeInfo? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        // 服务连接后立即启动 HTTP 服务器，不依赖 MainActivity 的 onResume。
        // onResume 可能在服务异步绑定前执行，导致 instance 仍为 null 而跳过启动。
        HttpServerHolder.start()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        // 更新窗口根节点引用
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
            event.eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED ||
            event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED
        ) {
            // 回收旧根节点
            currentRoot?.recycle()
            currentRoot = rootInActiveWindow?.also { node ->
                // 保留一个持久化副本（需要先 copy 再回收）
                // 当前实现直接持有引用，需注意使用时机
            }
        }

        // 存入事件缓冲
        eventBuffer.add(event)
        while (eventBuffer.size > MAX_EVENTS) {
            eventBuffer.poll()
        }
    }

    override fun onInterrupt() {}

    /** 获取当前根节点（调用方负责回收）。 */
    fun getRootCopy(): AccessibilityNodeInfo? {
        val root = currentRoot ?: rootInActiveWindow ?: return null
        return AccessibilityNodeInfo.obtain(root)
    }

    /** 获取自 sinceTs 以来的事件列表（JSON 序列化用）。 */
    fun getEventsSince(sinceTs: Long): List<AccessibilityEvent> {
        return eventBuffer.filter { it.eventTime > sinceTs }
    }
}