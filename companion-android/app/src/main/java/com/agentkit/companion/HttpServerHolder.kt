package com.agentkit.companion

/**
 * 持有 CompanionHttpServer 单例。
 *
 * 服务器在无障碍服务连接时启动（onServiceConnected），MainActivity 只在
 * 服务未连接时引导用户开启权限。避免依赖 Activity 生命周期导致服务绑定
 * 异步时机下服务器不启动。
 */
object HttpServerHolder {
    @Volatile
    private var server: CompanionHttpServer? = null

    /** 启动服务器（幂等：已启动则忽略）。 */
    fun start() {
        if (server != null) return
        try {
            server = CompanionHttpServer().apply { start() }
        } catch (e: Exception) {
            // 启动失败时清空引用，允许下次重试
            server = null
            throw e
        }
    }

    /** 停止服务器。 */
    fun stop() {
        server?.stop()
        server = null
    }
}