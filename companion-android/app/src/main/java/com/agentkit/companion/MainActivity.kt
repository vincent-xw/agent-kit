package com.agentkit.companion

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

/**
 * 引导用户开启无障碍权限，并启动 HTTP 服务器。
 * 服务器绑定 127.0.0.1:7777，仅 BFF 通过 adb forward 连接。
 */
class MainActivity : AppCompatActivity() {

    private var httpServer: CompanionHttpServer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
    }

    override fun onResume() {
        super.onResume()
        checkAccessibilityAndStart()
    }

    override fun onDestroy() {
        httpServer?.stop()
        super.onDestroy()
    }

    private fun checkAccessibilityAndStart() {
        val service = CompanionAccessibilityService.instance
        if (service == null) {
            showEnableDialog()
            return
        }
        startHttpServer()
    }

    private fun showEnableDialog() {
        AlertDialog.Builder(this)
            .setTitle("启用无障碍服务")
            .setMessage("Agent Kit Companion 需要无障碍服务权限才能读取屏幕内容。\n\n请在「已安装的应用」列表中找到并启用。")
            .setPositiveButton("去设置") { _, _ ->
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            .setNegativeButton("退出") { _, _ -> finish() }
            .setCancelable(false)
            .show()
    }

    private fun startHttpServer() {
        if (httpServer != null) return
        try {
            httpServer = CompanionHttpServer().apply { start() }
            Toast.makeText(this, "HTTP 服务器已启动: 127.0.0.1:7777", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "服务器启动失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }
}