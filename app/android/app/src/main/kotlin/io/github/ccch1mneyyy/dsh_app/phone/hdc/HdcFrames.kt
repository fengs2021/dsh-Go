package io.github.ccch1mneyyy.dsh_app.phone.hdc

import java.io.InputStream
import java.io.OutputStream

/**
 * hdc 帧的读写：`[PayloadHead 11B][PayloadProtect protobuf][payload]`。
 *
 * 只做流层面的拆包/组包，不含会话状态机（那部分在 HdcChannel 里）。
 * 这样可以在 JVM 单测里用 ByteArrayInputStream/OutputStream 验证，不需要真机。
 */
class HdcFrames(private val input: InputStream, private val output: OutputStream) {

    data class Frame(val channelId: Int, val commandFlag: Int, val payload: ByteArray)

    fun write(commandFlag: Int, channelId: Int, payload: ByteArray) {
        val protect = HdcCodec.encodeProtect(
            HdcCodec.Protect(channelId, commandFlag, checkSum = 0, vCode = HdcWire.V_CODE))
        val head = HdcWire.encodeHead(headSize = protect.size, dataSize = payload.size)
        output.write(head)
        output.write(protect)
        if (payload.isNotEmpty()) output.write(payload)
        output.flush()
    }

    /** 读一帧；流提前结束返回 null（调用方按「对端关闭」处理）。 */
    fun read(): Frame? {
        val head = readFully(HdcWire.HEAD_SIZE) ?: return null
        val sizes = HdcWire.decodeHead(head) ?: return null
        if (sizes.headSize > HdcWire.MAX_PACKET || sizes.dataSize > HdcWire.MAX_PACKET) return null
        val protectBytes = if (sizes.headSize > 0) readFully(sizes.headSize) ?: return null else ByteArray(0)
        val protect = if (protectBytes.isEmpty()) HdcCodec.Protect(0, 0, 0, 0) else HdcCodec.decodeProtect(protectBytes)
        val payload = if (sizes.dataSize > 0) readFully(sizes.dataSize) ?: return null else ByteArray(0)
        return Frame(protect.channelId, protect.commandFlag, payload)
    }

    private fun readFully(size: Int): ByteArray? {
        val buf = ByteArray(size)
        var read = 0
        while (read < size) {
            val n = input.read(buf, read, size - read)
            if (n <= 0) return null
            read += n
        }
        return buf
    }
}
