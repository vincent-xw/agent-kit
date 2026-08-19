package com.agentkit.companion

import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityEvent
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import org.json.JSONArray

/**
 * 绑定 127.0.0.1:7777 的 HTTP 服务器，提供无障碍树和操作接口。
 * 只有 BFF 通过 adb forward 连接，因此无需鉴权。
 */
class CompanionHttpServer(port: Int = 7777) : NanoHTTPD("127.0.0.1", port) {

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method
        return when {
            uri == "/tree" && method == Method.GET -> handleTree()
            uri == "/events" && method == Method.GET -> handleEvents(session)
            uri.startsWith("/node/") && method == Method.POST -> handleNodeAction(uri, session)
            else -> newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "not found")
        }
    }

    private fun handleTree(): Response {
        val service = CompanionAccessibilityService.instance ?: return error("服务未就绪")
        val root = service.getRootCopy() ?: return error("无法获取节点树")
        try {
            val nodes = NodeTreeDumper.dump(root)
            val result = JSONObject().apply {
                put("snapshotId", "companion:${System.currentTimeMillis()}")
                put("packageName", root.packageName?.toString() ?: "")
                put("screenWidth", 0)
                put("screenHeight", 0)
                put("nodes", nodes)
            }
            return newFixedLengthResponse(Response.Status.OK, "application/json", result.toString(2))
        } finally {
            root.recycle()
        }
    }

    private fun handleEvents(session: IHTTPSession): Response {
        val service = CompanionAccessibilityService.instance ?: return error("服务未就绪")
        val since = session.parameters["since"]?.firstOrNull()?.toLongOrNull() ?: 0L
        val events = service.getEventsSince(since)
        val arr = JSONArray()
        events.forEach { event ->
            val obj = JSONObject().apply {
                put("type", event.eventType)
                put("time", event.eventTime)
                put("packageName", event.packageName?.toString() ?: "")
                put("text", event.text?.toString() ?: "")
                put("sourceNodeId", event.source?.let { getNodeId(it) } ?: "")
            }
            arr.put(obj)
            event.recycle()
        }
        return newFixedLengthResponse(Response.Status.OK, "application/json", arr.toString())
    }

    private fun handleNodeAction(uri: String, session: IHTTPSession): Response {
        // 解析 /node/{ref}/{action}
        val parts = uri.trim('/').split('/')
        if (parts.size < 3) return error("路径格式错误")
        val ref = parts[1].toIntOrNull() ?: return error("ref 必须是整数")
        val action = parts[2]
        val body = parseBody(session)

        val service = CompanionAccessibilityService.instance ?: return error("服务未就绪")
        val root = service.getRootCopy() ?: return error("无法获取节点树")
        try {
            val node = findNodeByRef(root, ref) ?: return error("未找到节点 ref=$ref")
            return when (action) {
                "click" -> {
                    node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    ok("已点击")
                }
                "text" -> {
                    val text = body?.optString("text") ?: return error("缺少 text 参数")
                    node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                    // Android 无障碍服务的 ACTION_SET_TEXT 直接支持 Unicode
                    val args = android.os.Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
                    node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                    ok("已设置文本")
                }
                "scroll" -> {
                    val direction = body?.optString("direction") ?: "forward"
                    val action = if (direction == "backward") AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                    else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                    node.performAction(action)
                    ok("已滚动 $direction")
                }
                else -> error("未知操作: $action")
            }
        } finally {
            root.recycle()
        }
    }

    private fun findNodeByRef(node: AccessibilityNodeInfo, targetRef: Int, currentRef: IntArray = intArrayOf(-1)): AccessibilityNodeInfo? {
        // 与 NodeTreeDumper 保持一致：先记录当前节点（若 interesting），再无条件遍历子节点。
        // ref 从 0 开始。isInteresting 不通过的节点也继续遍历子树，保证 ref 编号一致。
        if (isInteresting(node)) {
            currentRef[0]++
            if (currentRef[0] == targetRef) return node
        }
        if (currentRef[0] >= 500) return null
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                val found = findNodeByRef(child, targetRef, currentRef)
                if (found != null) return found
                child.recycle()
            }
        }
        return null
    }

    private fun isInteresting(node: AccessibilityNodeInfo): Boolean {
        if (!node.isVisibleToUser) return false
        val hasText = !node.text.isNullOrBlank()
        val hasContentDesc = !node.contentDescription.isNullOrBlank()
        return hasText || hasContentDesc || node.isClickable || node.isScrollable || node.isEditable || node.isCheckable
    }

    private fun getNodeId(node: AccessibilityNodeInfo): String {
        return node.viewIdResourceName ?: node.className?.toString() ?: "unknown"
    }

    private fun parseBody(session: IHTTPSession): JSONObject? {
        return try {
            val body = HashMap<String, String>()
            session.parseBody(body)
            body["postData"]?.let { JSONObject(it) }
        } catch (_: Exception) { null }
    }

    private fun error(msg: String) = newFixedLengthResponse(Response.Status.BAD_REQUEST, "application/json",
        JSONObject().apply { put("ok", false); put("message", msg) }.toString())
    private fun ok(msg: String) = newFixedLengthResponse(Response.Status.OK, "application/json",
        JSONObject().apply { put("ok", true); put("message", msg) }.toString())
}