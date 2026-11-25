package io.github.ccch1mneyyy.dsh_app.phone.hdc

/**
 * hdc 3.2 线格式（「本机 → 鸿蒙 hdcd」TCP 直连场景）。
 *
 * 依据：OpenHarmony `developtools_hdc` 的 `hdc_rust/src/serializer/native_struct.rs`，
 * 并用一次真实抓包校正（179 字节的 CNXN）：
 *
 * ```
 * 48 57 | 00 00 | 01 | 00 08 | 00 00 00 a0 | 08 00 10 01 18 00 20 | 09 0a 08 "OHOS HDC" ...
 * flag    reserve  ver  headSize=8  dataSize=160   PayloadProtect(8B)      HandShake 负载
 * ```
 *
 * 结构（packed）：
 *   PayloadHead    flag[2] + reserve[2] + protocolVer(1) + headSize(2) + dataSize(4) = 11 字节
 *   PayloadProtect channelId(u32) + commandFlag(u32) + checkSum(u8) + vCode(u8)，序列化后通常 8 字节
 *   SessionHandShake banner / authType(u8) / sessionId(u32) / connectKey / buf / version
 *
 * 数值字段均为**大端**。
 */
object HdcWire {
    /** 2 字节包标志，源码常量 PACKET_FLAG = "HW"。 */
    val PACKET_FLAG = byteArrayOf('H'.code.toByte(), 'W'.code.toByte())

    /** 源码常量 VER_PROTOCOL = 0x01。 */
    const val PROTOCOL_VERSION: Int = 0x01

    /** PayloadHead 固定长度：2 + 2 + 1 + 2 + 4。 */
    const val HEAD_SIZE: Int = 11

    /** 明文链路的 reserve 两字节（加密/选项位）。 */
    const val RESERVE_PLAIN: Int = 0

    /** 静态 vCode，源码 `payloadProtectStaticVcode = 0x09`。 */
    const val V_CODE: Int = 0x09

    /** 源码常量 HANDSHAKE_MESSAGE = "OHOS HDC"（不超过 11 字节）。 */
    const val HANDSHAKE_MESSAGE: String = "OHOS HDC"

    /** 客户端版本串前缀；daemon 校验「Ver: + 版本 + 16 位十六进制 hash」。 */
    const val CLIENT_VERSION: String = "3.2.0c"

    /** 占位 hash：真实值取源码树 SHA-256 前 16 位，daemon 只校验形状。 */
    const val CLIENT_VERSION_HASH: String = "4a75add763b60a27"

    /** 鸿蒙「无线调试」页显示的默认端口。 */
    const val DEFAULT_PORT: Int = 45957

    /** 单条报文上限（源码里约 512 KiB）。 */
    const val MAX_PACKET: Int = 512 * 1024

    data class Head(val headSize: Int, val dataSize: Int)

    fun encodeHead(headSize: Int, dataSize: Int, reserve: Int = RESERVE_PLAIN): ByteArray {
        require(headSize in 0..MAX_PACKET) { "headSize" }
        require(dataSize in 0..MAX_PACKET) { "dataSize" }
        val out = ByteArray(HEAD_SIZE)
        out[0] = PACKET_FLAG[0]
        out[1] = PACKET_FLAG[1]
        out[2] = ((reserve ushr 8) and 0xFF).toByte()
        out[3] = (reserve and 0xFF).toByte()
        out[4] = PROTOCOL_VERSION.toByte()
        out[5] = ((headSize ushr 8) and 0xFF).toByte()
        out[6] = (headSize and 0xFF).toByte()
        out[7] = ((dataSize ushr 24) and 0xFF).toByte()
        out[8] = ((dataSize ushr 16) and 0xFF).toByte()
        out[9] = ((dataSize ushr 8) and 0xFF).toByte()
        out[10] = (dataSize and 0xFF).toByte()
        return out
    }

    /** flag 或版本不对返回 null（调用方按「不是 hdc」处理）。 */
    fun decodeHead(buf: ByteArray, offset: Int = 0): Head? {
        if (buf.size - offset < HEAD_SIZE) return null
        if (buf[offset] != PACKET_FLAG[0] || buf[offset + 1] != PACKET_FLAG[1]) return null
        if (buf[offset + 4].toInt() and 0xFF != PROTOCOL_VERSION) return null
        val headSize = ((buf[offset + 5].toInt() and 0xFF) shl 8) or (buf[offset + 6].toInt() and 0xFF)
        val dataSize = ((buf[offset + 7].toInt() and 0xFF) shl 24) or
            ((buf[offset + 8].toInt() and 0xFF) shl 16) or
            ((buf[offset + 9].toInt() and 0xFF) shl 8) or
            (buf[offset + 10].toInt() and 0xFF)
        return Head(headSize, dataSize)
    }

    /** 握手用的版本串。 */
    fun versionString(): String = "Ver: $CLIENT_VERSION$CLIENT_VERSION_HASH"
}
