package com.agentkit.companion

import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * 把 AccessibilityNodeInfo 树转成扁平 JSON 节点列表，与 BFF 的 DeviceNode 形状对齐。
 */
object NodeTreeDumper {

    fun dump(root: AccessibilityNodeInfo): JSONArray {
        val nodes = JSONArray()
        var ref = 0
        traverse(root, nodes, { ref++ })
        return nodes
    }

    private fun traverse(
        node: AccessibilityNodeInfo,
        result: JSONArray,
        nextRef: () -> Int,
    ) {
        if (!isInteresting(node)) return

        val obj = JSONObject()
        val ref = nextRef()
        obj.put("ref", ref)
        obj.put("nodeId", "node:$ref")

        node.text?.toString()?.takeIf { it.isNotBlank() }?.let { obj.put("text", it) }
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { obj.put("contentDescription", it) }
        node.className?.toString()?.takeIf { it.isNotBlank() }?.let { obj.put("className", it) }
        node.viewIdResourceName?.takeIf { it.isNotBlank() }?.let { obj.put("resourceId", it) }

        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)
        val boundsObj = JSONObject().apply {
            put("left", bounds.left)
            put("top", bounds.top)
            put("right", bounds.right)
            put("bottom", bounds.bottom)
        }
        obj.put("bounds", boundsObj)
        obj.put("clickable", node.isClickable)
        obj.put("scrollable", node.isScrollable)
        obj.put("editable", node.isEditable)
        obj.put("enabled", node.isEnabled)
        obj.put("focused", node.isFocused)
        obj.put("checked", node.isChecked)
        obj.put("selected", node.isSelected)

        result.put(obj)

        // 限制递归深度，避免过深节点
        if (ref < 500) {
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { child ->
                    traverse(child, result, nextRef)
                    child.recycle()
                }
            }
        }
    }

    /** 是否是有意义的节点（有文本、可交互、或是容器）。 */
    private fun isInteresting(node: AccessibilityNodeInfo): Boolean {
        if (!node.isVisibleToUser) return false
        val hasText = !node.text.isNullOrBlank()
        val hasContentDesc = !node.contentDescription.isNullOrBlank()
        val isInteractive = node.isClickable || node.isScrollable || node.isEditable || node.isCheckable || node.isFocusable
        return hasText || hasContentDesc || isInteractive
    }
}