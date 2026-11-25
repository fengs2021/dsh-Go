package io.github.ccch1mneyyy.dsh_app.phone.hdc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HdcWireTest {
    @Test
    fun head_is_nine_bytes_with_hw_flag_and_version() {
        val head = HdcWire.encodeHead(headSize = 0x0102, dataSize = 0x03040506)
        assertEquals(HdcWire.HEAD_SIZE, head.size)
        assertEquals('H'.code.toByte(), head[0])
        assertEquals('W'.code.toByte(), head[1])
        assertEquals(HdcWire.PROTOCOL_VERSION.toByte(), head[2])
        // 大端：headSize 2 字节、dataSize 4 字节
        assertEquals(listOf(0x01, 0x02, 0x03, 0x04, 0x05, 0x06), head.drop(3).map { it.toInt() and 0xFF })
    }

    @Test
    fun head_round_trips() {
        val head = HdcWire.encodeHead(headSize = 12, dataSize = 4096)
        val decoded = HdcWire.decodeHead(head)
        assertEquals(HdcWire.Head(12, 4096), decoded)
    }

    @Test
    fun decode_rejects_foreign_packets() {
        assertNull(HdcWire.decodeHead(byteArrayOf(1, 2, 3)))
        val badFlag = HdcWire.encodeHead(1, 1).also { it[0] = 'X'.code.toByte() }
        assertNull(HdcWire.decodeHead(badFlag))
        val badVersion = HdcWire.encodeHead(1, 1).also { it[2] = 0x7F }
        assertNull(HdcWire.decodeHead(badVersion))
    }

    @Test
    fun version_string_matches_daemon_shape() {
        // daemon 只校验「Ver: + 版本 + 16 位十六进制」的形状
        assertEquals("Ver: 3.2.0c4a75add763b60a27", HdcWire.versionString())
    }
}
