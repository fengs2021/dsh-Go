package io.github.ccch1mneyyy.dsh_app.phone.hdc

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * fixture 来自一次真实抓包（PC 的 hdc.exe 经 TCP relay 连鸿蒙 hdcd 时发出的 CNXN，179 字节）。
 */
class HdcCodecTest {
    private val frameHex =
        "48570000010008000000a0" + // PayloadHead：flag HW / reserve 0000 / ver 01 / headSize 0008 / dataSize 000000a0
        "08001001180020 09".replace(" ", "") + // PayloadProtect：channelId0 commandFlag1 checkSum0 vCode9
        "0a084f484f5320484443100018a3b0b7be07220f3132372e302e302e313a34363935372a5e617574687479706520202020202020203120202020202020202020202020202031737570706f7274666561747572657320323920202020202020202020202020205665723a20332e322e30632c5443502c77696e2c686561727462656174321b5665723a20332e322e306337666462633161613863356665666161"

    private fun bytes(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun header_matches_capture() {
        val head = bytes(frameHex.substring(0, 22)) // 11 字节
        val decoded = HdcWire.decodeHead(head)
        assertEquals(HdcWire.Head(headSize = 8, dataSize = 160), decoded)
    }

    @Test
    fun protect_matches_capture() {
        val protect = bytes(frameHex.substring(22, 38)) // 8 字节
        assertEquals("0800100118002009", protect.joinToString("") { "%02x".format(it) })
        assertEquals(HdcCodec.Protect(0, 1, 0, 9), HdcCodec.decodeProtect(protect))
        // 反向编码必须与原字节完全一致
        assertEquals(protect.joinToString("") { "%02x".format(it) },
            HdcCodec.encodeProtect(HdcCodec.Protect(0, 1, 0, 9)).joinToString("") { "%02x".format(it) })
    }

    @Test
    fun handshake_matches_capture() {
        val hs = bytes(frameHex.substring(38))
        val decoded = HdcCodec.decodeHandShake(hs)
        assertEquals("OHOS HDC", decoded.banner)
        assertEquals(0, decoded.authType)
        assertEquals("127.0.0.1:46957", decoded.connectKey)
        assertEquals(true, decoded.version.startsWith("Ver: 3.2.0c"))
    }

    @Test
    fun handshake_round_trips() {
        val encoded = HdcCodec.encodeHandShake(
            HdcCodec.HandShake("OHOS HDC", 0, 42, "10.0.0.2:45957", "", HdcWire.versionString()))
        val back = HdcCodec.decodeHandShake(encoded)
        assertEquals("OHOS HDC", back.banner)
        assertEquals(42, back.sessionId)
        assertEquals("10.0.0.2:45957", back.connectKey)
        assertEquals(HdcWire.versionString(), back.version)
    }
}
