import Foundation
import Security
import LocalAuthentication

enum SecureEnclaveError: LocalizedError {
    case keyGenerationFailed(OSStatus)
    case keyNotFound
    case publicKeyExportFailed
    case signingFailed(Error)
    case biometricCancelled

    var errorDescription: String? {
        switch self {
        case .keyGenerationFailed(let status):
            return "Key generation failed: \(status)"
        case .keyNotFound:
            return "Secure Enclave key not found"
        case .publicKeyExportFailed:
            return "Failed to export public key"
        case .signingFailed(let error):
            return "Signing failed: \(error.localizedDescription)"
        case .biometricCancelled:
            return "Biometric authentication was cancelled"
        }
    }
}

class SecureEnclaveManager {
    static let shared = SecureEnclaveManager()
    private let keyTag = "com.gellyfish.GellyfishApp.approval-key"
    private var keyTagData: Data { Data(keyTag.utf8) }

    private init() {}

    var hasKey: Bool {
        getPrivateKey() != nil
    }

    // MARK: - Key Generation

    func generateKeyPair() throws -> String {
        // Delete existing key first
        deleteKey()

        guard let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet],
            nil
        ) else {
            throw SecureEnclaveError.keyGenerationFailed(-1)
        }

        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: keyTagData,
                kSecAttrAccessControl as String: access,
            ] as [String: Any],
        ]

        var error: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            let status = (error?.takeRetainedValue() as? NSError)?.code ?? -1
            throw SecureEnclaveError.keyGenerationFailed(OSStatus(status))
        }

        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw SecureEnclaveError.publicKeyExportFailed
        }

        return try exportPublicKeyBase64(publicKey)
    }

    // MARK: - Public Key Export

    func getPublicKeyBase64() throws -> String {
        guard let privateKey = getPrivateKey() else {
            throw SecureEnclaveError.keyNotFound
        }
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw SecureEnclaveError.publicKeyExportFailed
        }
        return try exportPublicKeyBase64(publicKey)
    }

    private func exportPublicKeyBase64(_ publicKey: SecKey) throws -> String {
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw SecureEnclaveError.publicKeyExportFailed
        }
        return data.base64EncodedString()
    }

    // MARK: - Signing

    func sign(data: Data, context: LAContext? = nil) throws -> String {
        guard let privateKey = getPrivateKey(context: context) else {
            throw SecureEnclaveError.keyNotFound
        }

        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(
            privateKey,
            .ecdsaSignatureMessageX962SHA256,
            data as CFData,
            &error
        ) as Data? else {
            let underlying = error?.takeRetainedValue() as Error? ?? SecureEnclaveError.keyNotFound
            if let nsError = underlying as NSError?,
               nsError.domain == LAError.errorDomain,
               nsError.code == LAError.userCancel.rawValue {
                throw SecureEnclaveError.biometricCancelled
            }
            throw SecureEnclaveError.signingFailed(underlying)
        }

        return signature.base64EncodedString()
    }

    // MARK: - Key Deletion

    @discardableResult
    func deleteKey() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTagData,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess
    }

    // MARK: - Private Helpers

    private func getPrivateKey(context: LAContext? = nil) -> SecKey? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTagData,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
        ]
        if let ctx = context {
            query[kSecUseAuthenticationContext as String] = ctx
        }

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let key = item else { return nil }
        return (key as! SecKey)
    }
}
