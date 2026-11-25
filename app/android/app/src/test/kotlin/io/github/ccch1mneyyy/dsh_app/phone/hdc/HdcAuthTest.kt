package io.github.ccch1mneyyy.dsh_app.phone.hdc

import java.security.KeyPairGenerator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HdcAuthTest {
    @Test
    fun signs_token_with_sha512_rsa_and_verifies() {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(3072) }.generateKeyPair()
        val token = "hdcd-token-测试".toByteArray()
        val signature = HdcAuth.sign(token, pair.private)
        // base64 无换行、非空；3072 位签名 = 384 字节 → base64 512 字符
        assertTrue(signature.isNotEmpty())
        assertEquals(512, signature.length)
        assertTrue(HdcAuth.verify(token, signature, pair.public))
    }
}
