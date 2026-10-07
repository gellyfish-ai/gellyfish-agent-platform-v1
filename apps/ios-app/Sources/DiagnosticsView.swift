import SwiftUI
import UIKit

// MARK: - Model

/// A single approval attempt's diagnostic record.
///
/// Stages (set by PushNotificationManager as the flow progresses):
/// 1. `actionIntent` — what the user tapped ('approve' or 'reject'). Immutable.
/// 2. `lacontextResult` — biometric outcome: 'not_attempted' | 'succeeded' | 'failed_<reason>'.
/// 3. `postResult` — HTTP outcome: 'not_attempted' | '200' | '<status>' | 'network_error: <msg>'.
/// 4. `finalOutcome` — end-to-end outcome, recomputed as stages update.
///
/// `finalOutcome` is what UIs must show. `actionIntent` alone lies — a user can
/// tap Approve and still fail (biometric or network) (#735).
struct SignDiagnosticEntry: Identifiable, Equatable {
    let id: UUID
    let timestamp: Date
    let approvalId: String
    let mcpName: String
    let toolName: String
    let payloadHex: String
    let pubkeyHex: String?
    let nonceHex: String
    let actionHashHex: String

    /// 'approve' or 'reject' — what the user tapped. Immutable.
    let actionIntent: String

    /// 'not_attempted' | 'succeeded' | 'failed_user_interaction_required' | 'failed_<reason>'
    var lacontextResult: String

    /// 'not_attempted' | '200' | '<http_status>' | 'network_error: <msg>'
    var postResult: String

    /// 'pending' | 'approved' | 'rejected' | 'failed_biometric' | 'failed_post'
    var finalOutcome: String

    var signatureHex: String?
    var httpStatus: Int?
    var httpBody: String?

    static func == (lhs: SignDiagnosticEntry, rhs: SignDiagnosticEntry) -> Bool {
        lhs.id == rhs.id
    }
}

// MARK: - Final outcome logic

enum FinalOutcome {
    /// Derive final outcome from the current stage values.
    static func compute(intent: String, lacontext: String, post: String) -> String {
        // Successful end state: HTTP 200 means the gateway accepted the request.
        if post == "200" {
            return intent == "approve" ? "approved" : "rejected"
        }
        // Biometric failure — never reached HTTP.
        if lacontext.hasPrefix("failed") {
            return "failed_biometric"
        }
        // HTTP failure — biometric succeeded (or was skipped for reject) but post failed.
        if post.hasPrefix("network_error") || (post != "not_attempted" && post != "200") {
            return "failed_post"
        }
        return "pending"
    }
}

// MARK: - Store

@MainActor
final class SignDiagnosticsStore: ObservableObject {
    static let shared = SignDiagnosticsStore()

    private static let capacity = 100

    @Published private(set) var entries: [SignDiagnosticEntry] = []

    private init() {}

    /// Create a new entry in 'pending' state. Returns the id for later stage updates.
    @discardableResult
    func record(_ entry: SignDiagnosticEntry) -> UUID {
        entries.append(entry)
        if entries.count > Self.capacity {
            entries.removeFirst(entries.count - Self.capacity)
        }
        return entry.id
    }

    /// Update the LAContext stage result and recompute final outcome.
    func updateLAContextResult(id: UUID, result: String) {
        guard let idx = entries.firstIndex(where: { $0.id == id }) else { return }
        var updated = entries[idx]
        updated.lacontextResult = result
        updated.finalOutcome = FinalOutcome.compute(
            intent: updated.actionIntent,
            lacontext: updated.lacontextResult,
            post: updated.postResult
        )
        entries[idx] = updated
    }

    /// Set the signature hex (after a successful sign).
    func updateSignature(id: UUID, signatureHex: String?) {
        guard let idx = entries.firstIndex(where: { $0.id == id }) else { return }
        var updated = entries[idx]
        updated.signatureHex = signatureHex
        entries[idx] = updated
    }

    /// Update the HTTP/post stage and recompute final outcome.
    func updatePostResult(id: UUID, status: Int?, body: String?) {
        guard let idx = entries.firstIndex(where: { $0.id == id }) else { return }
        var updated = entries[idx]
        updated.httpStatus = status
        updated.httpBody = body
        if let status {
            updated.postResult = "\(status)"
        } else if let body, body.hasPrefix("network error:") {
            updated.postResult = "network_error: \(body.replacingOccurrences(of: "network error: ", with: ""))"
        } else {
            updated.postResult = "network_error"
        }
        updated.finalOutcome = FinalOutcome.compute(
            intent: updated.actionIntent,
            lacontext: updated.lacontextResult,
            post: updated.postResult
        )
        entries[idx] = updated
    }

    /// 20 newest, newest-first.
    var newestForList: [SignDiagnosticEntry] {
        Array(entries.suffix(20).reversed())
    }

    /// JSON dump of every entry, newest-first, prefixed with "ios_side:" marker.
    func copyAllText() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let dicts: [[String: Any]] = entries.reversed().map { e in
            var d: [String: Any] = [
                "id": e.id.uuidString,
                "timestamp": formatter.string(from: e.timestamp),
                "approvalId": e.approvalId,
                "mcp": e.mcpName,
                "tool": e.toolName,
                "nonce": e.nonceHex,
                "action_hash": e.actionHashHex,
                "payload_hex": e.payloadHex,
                "action_intent": e.actionIntent,
                "lacontext_result": e.lacontextResult,
                "post_result": e.postResult,
                "final_outcome": e.finalOutcome,
            ]
            if let s = e.signatureHex { d["signature_hex"] = s }
            if let p = e.pubkeyHex { d["pubkey_hex"] = p }
            if let s = e.httpStatus { d["http_status"] = s }
            if let b = e.httpBody { d["http_body"] = b }
            return d
        }

        let data = (try? JSONSerialization.data(withJSONObject: dicts, options: [.prettyPrinted])) ?? Data()
        let json = String(data: data, encoding: .utf8) ?? "[]"
        return "ios_side:\n\(json)"
    }
}

// MARK: - Helpers

extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - View

struct DiagnosticsView: View {
    @ObservedObject private var store = SignDiagnosticsStore.shared
    @State private var copiedFlash = false

    var body: some View {
        Group {
            if store.entries.isEmpty {
                ContentUnavailableView(
                    "No signing attempts yet",
                    systemImage: "signature",
                    description: Text("Respond to an approval push and the signed payload will appear here.")
                )
            } else {
                List(store.newestForList) { entry in
                    NavigationLink {
                        DiagnosticDetailView(entry: entry)
                    } label: {
                        DiagnosticRow(entry: entry)
                    }
                }
            }
        }
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    UIPasteboard.general.string = store.copyAllText()
                    copiedFlash = true
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copiedFlash = false }
                } label: {
                    Label(copiedFlash ? "Copied" : "Copy all", systemImage: copiedFlash ? "checkmark" : "doc.on.doc")
                }
                .disabled(store.entries.isEmpty)
            }
        }
    }
}

private struct DiagnosticRow: View {
    let entry: SignDiagnosticEntry

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    private var outcomeColor: Color {
        switch entry.finalOutcome {
        case "approved": return .green
        case "rejected": return .red
        case "failed_biometric", "failed_post": return .orange
        case "pending": return .yellow
        default: return .gray
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(entry.finalOutcome.uppercased())
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundStyle(outcomeColor)
                Spacer()
                Text(Self.timeFormatter.string(from: entry.timestamp))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(entry.approvalId)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
            HStack(spacing: 6) {
                Text("intent=\(entry.actionIntent) la=\(entry.lacontextResult) post=\(entry.postResult)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.vertical, 2)
    }
}

struct DiagnosticDetailView: View {
    let entry: SignDiagnosticEntry

    var body: some View {
        List {
            Section("Summary") {
                LabeledRow("Final outcome", entry.finalOutcome)
                LabeledRow("Action intent", entry.actionIntent)
                LabeledRow("LAContext", entry.lacontextResult)
                LabeledRow("Post", entry.postResult)
                if let s = entry.httpStatus {
                    LabeledRow("HTTP status", String(s))
                }
                LabeledRow("Timestamp", entry.timestamp.formatted(date: .abbreviated, time: .standard))
            }

            Section("Identifiers") {
                MonoRow("Approval ID", entry.approvalId)
                MonoRow("MCP", entry.mcpName)
                MonoRow("Tool", entry.toolName)
            }

            Section("Signed payload") {
                MonoRow("Nonce", entry.nonceHex)
                MonoRow("Action hash", entry.actionHashHex)
                MonoRow("Payload hex", entry.payloadHex)
            }

            Section("Crypto") {
                MonoRow("Pubkey (raw X9.63, hex)", entry.pubkeyHex ?? "—")
                MonoRow("Signature (hex)", entry.signatureHex ?? "—")
            }

            if let body = entry.httpBody, !body.isEmpty {
                Section("HTTP body") {
                    Text(body)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                }
            }

            Section {
                ShareLink(item: shareText(for: entry)) {
                    Label("Share diagnostic", systemImage: "square.and.arrow.up")
                }
            }
        }
        .navigationTitle("Signing Attempt")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func shareText(for e: SignDiagnosticEntry) -> String {
        """
        ios_side:
        approval: \(e.approvalId)
        mcp: \(e.mcpName) / \(e.toolName)
        nonce: \(e.nonceHex)
        action_hash: \(e.actionHashHex)
        payload_hex: \(e.payloadHex)
        pubkey (raw X9.63, hex): \(e.pubkeyHex ?? "-")
        signature (hex): \(e.signatureHex ?? "-")
        action_intent: \(e.actionIntent)
        lacontext_result: \(e.lacontextResult)
        post_result: \(e.postResult)
        final_outcome: \(e.finalOutcome)
        http_status: \(e.httpStatus.map(String.init) ?? "-")
        http_body: \(e.httpBody ?? "-")
        """
    }
}

// MARK: - Small row helpers

private struct LabeledRow: View {
    let title: String
    let value: String
    init(_ title: String, _ value: String) { self.title = title; self.value = value }
    var body: some View {
        HStack {
            Text(title).foregroundStyle(.secondary)
            Spacer()
            Text(value)
        }
    }
}

private struct MonoRow: View {
    let title: String
    let value: String
    init(_ title: String, _ value: String) { self.title = title; self.value = value }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
        }
        .padding(.vertical, 2)
    }
}
