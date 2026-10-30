import Foundation
import Security
import CallCore

enum SettingsStore {
    private static let service = "OpenCodeCall.connection"
    static func load() throws -> ConnectionSettings {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "personal",
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var value: CFTypeRef?
        let result = SecItemCopyMatching(query as CFDictionary, &value)
        if result == errSecItemNotFound { return ConnectionSettings() }
        guard result == errSecSuccess, let data = value as? Data else { throw CallError.message("Could not read settings from Keychain (\(result))") }
        return try JSONDecoder().decode(ConnectionSettings.self, from: data)
    }
    static func save(_ settings: ConnectionSettings) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "personal"]
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(settings),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, value in value } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw CallError.message("Could not save credentials in Keychain (\(status))") }
    }
}
