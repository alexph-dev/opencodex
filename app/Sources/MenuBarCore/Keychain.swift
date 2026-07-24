import Foundation
import Security

/// Generic-password storage for the optional management API key.
///
/// The key is read lazily — only after a 401 — and is never written to UserDefaults,
/// never logged, and never included in an error surfaced to the UI.
///
/// **Read-only in practice today.** Nothing in the app calls `write`: there is no key
/// entry UI yet, so a user with a non-loopback proxy has to create the Keychain item
/// themselves. `write`/`delete` exist for the entry flow that is planned, and the docs
/// say plainly that the case is not fully supported rather than implying it works.
///
/// Every query sets `kSecUseDataProtectionKeychain`. Without it, `kSecAttrAccessible` is
/// ignored on macOS (it applies only to data-protection or synchronizable items), so the
/// declared accessibility class would be decorative. Setting it on *all* operations also
/// matters for correctness: a data-protection item is invisible to a query that omits
/// the flag, so a mixed set of queries would fail to find or delete its own items.
public enum Keychain {
    public static let service = "com.opencodex.menubar.apikey"
    public static let defaultAccount = "default"

    private static func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    public static func read(account: String = defaultAccount) -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8),
              !value.isEmpty
        else { return nil }
        return value
    }

    @discardableResult
    public static func write(_ value: String, account: String = defaultAccount) -> Bool {
        let data = Data(value.utf8)

        // Update first, add only when absent. Deleting first would destroy a working key
        // whenever the subsequent add failed.
        let updateStatus = SecItemUpdate(
            baseQuery(account: account) as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess { return true }
        guard updateStatus == errSecItemNotFound else { return false }

        var attributes = baseQuery(account: account)
        attributes[kSecValueData as String] = data
        // ThisDeviceOnly: the key is a local proxy credential with no reason to migrate
        // to another machine via backup or transfer.
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    public static func delete(account: String = defaultAccount) -> Bool {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
