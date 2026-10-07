import Foundation

/// In-process registry of recent password fills.
///
/// `safe_snapshot` reads this to decide whether to redact a given input even
/// when the field is not `<input type="password">` — sites like idmsa hide a
/// `type="text"` input behind `-webkit-text-security: disc` and rely on
/// `autocomplete` hints, so we cannot trust DOM `type` alone. If we just
/// filled this URL+selector recently, treat that input as a password sink.
///
/// Scope is per-process: each agent spawns its own keychain MCP child over
/// stdio, so entries are never visible to another agent.
final class RecentFillsRegistry {
    static let shared = RecentFillsRegistry()

    /// 5-minute TTL — long enough to span an OAuth round-trip with an
    /// approval prompt, short enough that a stale entry from a closed tab
    /// cannot survive into an unrelated browsing session.
    private let ttl: TimeInterval = 5 * 60

    /// Bounded buffer — `safe_snapshot` ships the snapshot inline to the
    /// model, so an unbounded list would balloon prompt size.
    private let maxEntries = 50

    struct Entry: Codable {
        let urlHost: String
        let selector: String
        /// Unix epoch seconds. JS side compares against Date.now()/1000.
        let recordedAt: Double
    }

    private let lock = NSLock()
    private var entries: [Entry] = []

    private init() {}

    /// Record a successful fill. Drops silently if `url` does not parse —
    /// recording is best-effort observability for redaction, not a
    /// user-facing operation, so failing here would block legitimate fills.
    func record(url: String, selector: String) {
        guard let host = URL(string: url)?.host?.lowercased(), !host.isEmpty else { return }
        let entry = Entry(urlHost: host, selector: selector, recordedAt: Date().timeIntervalSince1970)
        lock.lock()
        defer { lock.unlock() }
        entries.append(entry)
        if entries.count > maxEntries {
            entries.removeFirst(entries.count - maxEntries)
        }
    }

    /// Snapshot of non-expired entries as a JSON string, suitable for
    /// passing to the `safe-snapshot.js` child process via env var.
    /// Returns `"[]"` when the registry is empty so the child does not
    /// have to handle missing/undefined env values.
    func snapshotJSON() -> String {
        let cutoff = Date().timeIntervalSince1970 - ttl
        lock.lock()
        let live = entries.filter { $0.recordedAt >= cutoff }
        entries = live
        let copy = live
        lock.unlock()

        guard let data = try? JSONEncoder().encode(copy),
              let str = String(data: data, encoding: .utf8) else {
            return "[]"
        }
        return str
    }
}
