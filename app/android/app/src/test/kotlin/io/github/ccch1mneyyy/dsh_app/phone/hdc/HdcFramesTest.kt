package io.github.ccch1mneyyy.dsh_app.phone.hdc

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HdcFramesTest {
    @Test
    fun writes_and_reads_back_one_frame() {
        val wire = ByteArrayOutputStream()
        val payload = "echo hi".toByteArray()
        HdcFrames(ByteArrayInputStream(ByteArray(0)), wire).write(HdcWire.CMD_CONNECT, 0, payload)

        val frame = HdcFrames(ByteArrayInputStream(wire.toByteArray()), ByteArrayOutputStream()).read()!!
        assertEquals(0, frame.channelId)
        assertArrayEquals(payload, frame.payload)
        assertEquals(11 + 8, wire.size() - payload.size) // 头 11 + protect 8
    }

    @Test
    fun truncated_stream_reads_null() {
        val wire = ByteArrayOutputStream()
        HdcFrames(ByteArrayInputStream(ByteArray(0)), wire).write(1, 3, ByteArray(4))
        val bytes = wire.toByteArray()
        assertNull(HdcFrames(ByteArrayInputStream(bytes.copyOf(10)), ByteArrayOutputStream()).read())
        assertNull(HdcFrames(ByteArrayInputStream(bytes.copyOf(bytes.size - 2)), ByteArrayOutputStream()).read())
    }
}
