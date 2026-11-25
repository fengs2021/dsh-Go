package io.github.ccch1mneyyy.dsh_app.phone.hdc

/**
 * hdc 3.2 线格式的最小实现（只做「本机 → 鸿蒙手机 hdcd」这一种 TCP 直连场景）。
 *
 * 事实来自 OpenHarmony `developtools_hdc` 源码（src/common/session.cpp:Send、
 * src/common/define.h）。一条消息是：
 *
 *   PayloadHead（固定 9 字节，全部网络字节序）
 *     flag[2]        "HW"
 *     protocolVer    1
 *     headSize       2  —— 后面 PayloadProtect 序列化后的长度
 *     dataSize       4  —— 业务负载长度
 *   PayloadProtect（变长，SerialStruct 序列化；非加密链路只有 vCode 与可选校验和）
 *   data（dataSize 字节）
 *
 * 本文件只负责「头」的编码/解码与常量，网络与握手在 HdcChannel 里；单独成文件是为了能
 * 在 JVM 单元测试里验证字节布局，不依赖真机。
 */
object HdcWire {
    /** 2 字节包标志，源码常量 PACKET_FLAG = "HW"。 */
    val PACKET_FLAG = byteArrayOf('H'.code.toByte(), 'W'.code.toByte())

    /** 源码常量 VER_PROTOCOL = 0x01。 */
    const val PROTOCOL_VERSION: Int = 0x01

    /** PayloadHead 固定长度。 */
    const val HEAD_SIZE: Int = 9

    /** 源码常量 HANDSHAKE_MESSAGE = "OHOS HDC"（不超过 11 字节）。 */
    const val HANDSHAKE_MESSAGE: String = "OHOS HDC"

    /** 我们自己的客户端版本串前缀；daemon 会校验「Ver: + 版本 + 16 位十六进制 hash」。 */
    const val CLIENT_VERSION: String = "3.2.0c"

    /** 十六进制占位 hash：真实值由源码树 SHA-256 前 16 位生成；daemon 只校验形状。 */
    const val CLIENT_VERSION_HASH: String = "4a75add763b60a27"

    /** 默认端口：鸿蒙「无线调试」页显示的 hdc 端口。 */
    const val DEFAULT_PORT: Int = 45957

    /** 头 + 负载的最大报文，超过即视为协议错误（源码里约 512 KiB）。 */
    const val MAX_PACKET: Int = 512 * 1024

    /** 头字段。 */
    data class Head(val headSize: Int, val dataSize: Int)

    fun encodeHead(headSize: Int, dataSize: Int): ByteArray {
        require(headSize in 0..MAX_PACKET) { "headSize" }
        require(dataSize in 0..MAX_PACKET) { "dataSize" }
        val out = ByteArray(HEAD_SIZE)
        out[0] = PACKET_FLAG[0]
        out[1] = PACKET_FLAG[1]
        out[2] = PROTOCOL_VERSION.toByte()
        out[3] = ((headSize ushr 8) and 0xFF).toByte()
        out[4] = (headSize and 0xFF).toByte()
        out[5] = ((dataSize ushr 24) and 0xFF).toByte()
        out[6] = ((dataSize ushr 16) and 0xFF).toByte()
        out[7] = ((dataSize ushr 8) and 0xFF).toByte()
        out[8] = (dataSize and 0xFF).toByte()
        return out
    }

    /** 解出 headSize/dataSize；flag 或版本不对返回 null（调用方按「不是 hdc」处理）。 */
    fun decodeHead(buf: ByteArray, offset: Int = 0): Head? {
        if (buf.size - offset < HEAD_SIZE) return null
        if (buf[offset] != PACKET_FLAG[0] || buf[offset + 1] != PACKET_FLAG[1]) return null
        if (buf[offset + 2].toInt() and 0xFF != PROTOCOL_VERSION) return null
        val headSize = ((buf[offset + 3].toInt() and 0xFF) shl 8) or (buf[offset + 4].toInt() and 0xFF)
        val dataSize = ((buf[offset + 5].toInt() and 0xFF) shl 24) or
            ((buf[offset + 6].toInt() and 0xFF) shl 16) or
            ((buf[offset + 7].toInt() and 0xFF) shl 8) or
            (buf[offset + 8].toInt() and 0xFF)
        return Head(headSize, dataSize)
    }

    /** 握手用的版本串。 */
    fun versionString(): String = "Ver: $CLIENT_VERSION$CLIENT_VERSION_HASH"
}
