import SwiftUI
import UIKit

struct ApprovalCardView: View {
    let approval: ApprovalPayload
    let onRespond: (String) async -> ApprovalResponseResult
    let onDismiss: () -> Void

    @State private var timeRemaining: TimeInterval = 0
    @State private var age: TimeInterval = 0       // seconds since created_at (#743)
    @State private var pendingState: String?      // "approved" or "rejected" while awaiting
    @State private var succeededState: String?    // set briefly after success, before dismiss
    @State private var errorMessage: String?

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var isBusy: Bool { pendingState != nil || succeededState != nil }

    /// Cards older than this are visually marked stale (#743). User can still
    /// tap through; the gateway validates TTL and will 410 if expired.
    private static let staleThreshold: TimeInterval = 60

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 16) {
                // Header
                HStack {
                    Text("Approval Required")
                        .font(.headline)
                    Spacer()
                    timerBadge
                }

                // Age / freshness indicator (#743)
                ageBadge

                // Details
                VStack(alignment: .leading, spacing: 8) {
                    Label("\(approval.agentName) (\(approval.profileName))", systemImage: "person.circle")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    Label(approval.tool, systemImage: "wrench")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    if !approval.summary.isEmpty {
                        Text(approval.summary)
                            .font(.body)
                            .padding(.top, 4)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                // Actions
                HStack(spacing: 12) {
                    Button {
                        Task { await respond(state: "rejected") }
                    } label: {
                        buttonLabel(for: "rejected", title: "Reject", successTitle: "Rejected")
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                    .disabled(isBusy || approval.isExpired)

                    Button {
                        Task { await respond(state: "approved") }
                    } label: {
                        buttonLabel(for: "approved", title: "Approve", successTitle: "Approved")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                    .disabled(isBusy || approval.isExpired)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .transition(.opacity)
                }
            }
            .padding(20)
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .shadow(color: .black.opacity(0.3), radius: 20, y: 10)
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .animation(.easeInOut(duration: 0.2), value: errorMessage)
        .animation(.easeInOut(duration: 0.2), value: pendingState)
        .animation(.easeInOut(duration: 0.2), value: succeededState)
        .onAppear {
            timeRemaining = max(0, approval.expiresAt.timeIntervalSinceNow)
            age = approval.ageSeconds
        }
        .onReceive(timer) { _ in
            timeRemaining = max(0, approval.expiresAt.timeIntervalSinceNow)
            age = approval.ageSeconds
            if timeRemaining <= 0 && !isBusy {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    if !isBusy { onDismiss() }
                }
            }
        }
    }

    /// Relative-age label (e.g. "just now", "12s ago", "1m 5s ago"). Turns
    /// orange once the card is older than `staleThreshold` seconds (#743).
    private var ageBadge: some View {
        let isStale = age > Self.staleThreshold
        let label: String = {
            let a = Int(age)
            if a < 3 { return "just now" }
            if a < 60 { return "\(a)s ago" }
            let minutes = a / 60
            let seconds = a % 60
            if minutes < 60 { return "\(minutes)m \(seconds)s ago" }
            return "over an hour ago"
        }()
        return HStack(spacing: 6) {
            Image(systemName: isStale ? "exclamationmark.triangle.fill" : "clock")
                .font(.caption)
            Text(label)
                .font(.caption)
            if isStale {
                Text("— may have expired")
                    .font(.caption2)
            }
        }
        .foregroundStyle(isStale ? .orange : .secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func buttonLabel(for state: String, title: String, successTitle: String) -> some View {
        if succeededState == state {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                Text(successTitle)
            }
            .fontWeight(.semibold)
            .frame(maxWidth: .infinity)
        } else if pendingState == state {
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.small)
                Text("Signing…")
            }
            .fontWeight(.semibold)
            .frame(maxWidth: .infinity)
        } else {
            Text(title)
                .fontWeight(.semibold)
                .frame(maxWidth: .infinity)
        }
    }

    private func respond(state: String) async {
        pendingState = state
        errorMessage = nil

        let result = await onRespond(state)
        pendingState = nil

        switch result {
        case .success:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            succeededState = state
            try? await Task.sleep(nanoseconds: 500_000_000)
            onDismiss()
        case .cancelled:
            // Biometric cancelled — keep the sheet open, let the user retry.
            break
        case .failure(let message):
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            errorMessage = "Failed: \(message)"
        }
    }

    private var timerBadge: some View {
        let minutes = Int(timeRemaining) / 60
        let seconds = Int(timeRemaining) % 60
        let isUrgent = timeRemaining < 30

        return Text(String(format: "%d:%02d", minutes, seconds))
            .font(.system(.caption, design: .monospaced))
            .fontWeight(.medium)
            .foregroundStyle(isUrgent ? .red : .secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(isUrgent ? Color.red.opacity(0.15) : Color.secondary.opacity(0.1))
            .clipShape(Capsule())
    }
}
