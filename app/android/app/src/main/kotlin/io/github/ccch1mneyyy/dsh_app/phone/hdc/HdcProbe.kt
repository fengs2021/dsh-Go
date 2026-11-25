package io.github.ccch1mneyyy.dsh_app.phone.hdc

import java.net.InetSocketAddress
import java.net.Socket

/**
 * 最小自检：连一台鸿蒙手机的 hdcd，发 CNXN，读回包，返回人类可读的结论。
 *
 * 只验证「线格式 + 握手」，不做认证（那一步要 RSA 签名，见 docs/design/android-port/hdc-channel.zh.md）。
 */
object HdcProbe {

    fun probe(host: String, port: Int = HdcWire.DEFAULT_PORT, timeoutMs: Int = 5000): String {
        val socket = Socket()
        return try {
            socket.connect(InetSocketAddress(host, port), timeoutMs)
            socket.soTimeout = timeoutMs
            val frames = HdcFrames(socket.getInputStream(), socket.getOutputStream())
            val handshake = HdcCodec.encodeHandShake(
                HdcCodec.HandShake(
                    banner = HdcWire.HANDSHAKE_MESSAGE,
                    authType = 0,
                    sessionId = 1,
                    connectKey = "$host:$port",
                    buf = "authtype 1 supportfeatures 29 ${HdcWire.versionString()}",
                    version = HdcWire.versionString(),
                )
            )
            frames.write(HdcWire.CMD_CONNECT, 0, handshake)
            val reply = frames.read() ?: return "握手失败：对端未回包"
            val decoded = HdcCodec.decodeHandShake(reply.payload)
            "握手成功：cmd=${reply.commandFlag} banner='${decoded.banner}' authType=${decoded.authType} " +
                "version='${decoded.version.take(24)}'（${reply.payload.size} B）"
        } catch (error: Exception) {
            "连接失败：${error.javaClass.simpleName}: ${error.message}"
        } finally {
            runCatching { socket.close() }
        }
    }
}
