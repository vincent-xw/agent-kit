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
 * 服务器由 CompanionAccessibilityService.onServiceConnected 启动，
 * 此 Activity 仅在服务未连接时引导开启权限。
 */
class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
    }

    override fun onResume() {
        super.onResume()
        checkAccessibilityAndStart()
    }

    private fun checkAccessibilityAndStart() {
        val service = CompanionAccessibilityService.instance
        if (service == null) {
            // 服务未连接：服务启动的服务器会随权限开启后由 onServiceConnected 补启动
            showEnableDialog()
            return
        }
        try {
            HttpServerHolder.start()
            Toast.makeText(this, "HTTP 服务器已启动: 127.0.0.1:7777", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "服务器启动失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
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
}