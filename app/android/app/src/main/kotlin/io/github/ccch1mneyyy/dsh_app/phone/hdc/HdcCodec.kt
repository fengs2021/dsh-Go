package io.github.ccch1mneyyy.dsh_app.phone.hdc

/**
 * `PayloadProtect` 与 `SessionHandShake` 的线编码。
 *
 * 上游用的是 `Hdc::SerialStruct`（模板序列化），但**线上格式就是 protobuf 的 wire format**：
 * 字段按声明顺序编号，varint 用 wire type 0、字符串用 wire type 2。
 * 这一点用真实抓包验证过（见 HdcCodecTest 里的 fixture）：
 *
 * ```
 * PayloadProtect(channelId=0, commandFlag=1, checkSum=0, vCode=9)
 *   → 08 00 | 10 01 | 18 00 | 20 09
 * SessionHandShake(banner="OHOS HDC", ...)
 *   → 0a 08 "OHOS HDC" | 10 00 | 18 <varint sessionId> | 22 0f "host:port" | 2a …
 * ```
 */
object HdcCodec {
    /** 保护头：channelId / commandFlag / checkSum / vCode。 */
    data class Protect(val channelId: Int, val commandFlag: Int, val checkSum: Int, val vCode: Int)

    /** 握手：banner 必须排第一（上游注释 “must first index”）。 */
    data class HandShake(
        val banner: String,
        val authType: Int,
        val sessionId: Int,
        val connectKey: String,
        val buf: String,
        val version: String,
    )

    private fun varint(out: MutableList<Byte>, value: Long) {
        var v = value
        while (true) {
            val b = (v and 0x7F).toInt()
            v = v ushr 7
            if (v == 0L) {
                out.add(b.toByte()); return
            }
            out.add((b or 0x80).toByte())
        }
    }

    private fun key(out: MutableList<Byte>, field: Int, wireType: Int) = varint(out, ((field shl 3) or wireType).toLong())

    private fun uintField(out: MutableList<Byte>, field: Int, value: Int) {
        key(out, field, 0); varint(out, value.toLong() and 0xFFFFFFFFL)
    }

    private fun stringField(out: MutableList<Byte>, field: Int, value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        key(out, field, 2); varint(out, bytes.size.toLong()); bytes.forEach { out.add(it) }
    }

    fun encodeProtect(p: Protect): ByteArray {
        val out = ArrayList<Byte>(16)
        uintField(out, 1, p.channelId)
        uintField(out, 2, p.commandFlag)
        uintField(out, 3, p.checkSum)
        uintField(out, 4, p.vCode)
        return out.toByteArray()
    }

    fun encodeHandShake(h: HandShake): ByteArray {
        val out = ArrayList<Byte>(160)
        stringField(out, 1, h.banner)
        uintField(out, 2, h.authType)
        uintField(out, 3, h.sessionId)
        stringField(out, 4, h.connectKey)
        stringField(out, 5, h.buf)
        stringField(out, 6, h.version)
        return out.toByteArray()
    }

    /** 解析 `PayloadProtect`。缺字段按 0 处理（上游同样宽容）。 */
    fun decodeProtect(buf: ByteArray): Protect {
        var channelId = 0; var commandFlag = 0; var checkSum = 0; var vCode = 0
        var i = 0
        while (i < buf.size) {
            val (k, next) = readVarint(buf, i) ?: break
            i = next
            val field = (k ushr 3).toInt(); val wire = (k and 7).toInt()
            when (wire) {
                0 -> {
                    val (v, n) = readVarint(buf, i) ?: break
                    i = n
                    when (field) {
                        1 -> channelId = v.toInt(); 2 -> commandFlag = v.toInt()
                        3 -> checkSum = v.toInt(); 4 -> vCode = v.toInt()
                    }
                }
                2 -> { val (len, n) = readVarint(buf, i) ?: break; i = n + len.toInt() }
                else -> return Protect(channelId, commandFlag, checkSum, vCode)
            }
        }
        return Protect(channelId, commandFlag, checkSum, vCode)
    }

    /** 解析 `SessionHandShake`。 */
    fun decodeHandShake(buf: ByteArray): HandShake {
        var banner = ""; var authType = 0; var sessionId = 0
        var connectKey = ""; var body = ""; var version = ""
        var i = 0
        while (i < buf.size) {
            val (k, next) = readVarint(buf, i) ?: break
            i = next
            val field = (k ushr 3).toInt(); val wire = (k and 7).toInt()
            if (wire == 0) {
                val (v, n) = readVarint(buf, i) ?: break
                i = n
                when (field) { 2 -> authType = v.toInt(); 3 -> sessionId = v.toInt() }
            } else if (wire == 2) {
                val (len, n) = readVarint(buf, i) ?: break
                i = n
                if (i + len > buf.size) break
                val text = String(buf, i, len.toInt(), Charsets.UTF_8)
                i += len.toInt()
                when (field) { 1 -> banner = text; 4 -> connectKey = text; 5 -> body = text; 6 -> version = text }
            } else {
                break
            }
        }
        return HandShake(banner, authType, sessionId, connectKey, body, version)
    }

    private fun readVarint(buf: ByteArray, start: Int): Pair<Long, Int>? {
        var result = 0L; var shift = 0; var i = start
        while (i < buf.size) {
            val b = buf[i].toInt() and 0xFF
            i++
            result = result or ((b and 0x7F).toLong() shl shift)
            if (b and 0x80 == 0) return result to i
            shift += 7
            if (shift > 63) return null
        }
        return null
    }
}
