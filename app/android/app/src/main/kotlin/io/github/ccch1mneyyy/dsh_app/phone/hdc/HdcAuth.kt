package io.github.ccch1mneyyy.dsh_app.phone.hdc

import java.security.KeyFactory
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64

/**
 * hdc 的密钥认证（`RSA_3072_SHA512`）：把 daemon 给的 token 用私钥做 SHA512withRSA 签名，
 * 再 base64 —— 与上游 `HdcAuth::RsaSignAndBase64(buf, AuthVerifyType::RSA_3072_SHA512)` 等价：
 * 它用 OpenSSL `EVP_DigestSign` 做 SHA512 摘要签名，再 `EVP_EncodeBlock`（标准 base64，无换行）。
 */
object HdcAuth {

    /** PKCS#8 PEM / DER 私钥 → [PrivateKey]。 */
    fun loadPrivateKey(pkcs8: ByteArray): PrivateKey {
        val spec = PKCS8EncodedKeySpec(pkcs8)
        return KeyFactory.getInstance("RSA").generatePrivate(spec)
    }

    /** 对 token 签名并返回 base64（无换行）。 */
    fun sign(token: ByteArray, key: PrivateKey): String {
        val signature = Signature.getInstance("SHA512withRSA")
        signature.initSign(key)
        signature.update(token)
        return Base64.getEncoder().encodeToString(signature.sign())
    }

    /** 验证签名，仅用于自检/单测。 */
    fun verify(token: ByteArray, base64Signature: String, key: java.security.PublicKey): Boolean {
        val signature = Signature.getInstance("SHA512withRSA")
        signature.initVerify(key)
        signature.update(token)
        return signature.verify(Base64.getDecoder().decode(base64Signature))
    }
}
