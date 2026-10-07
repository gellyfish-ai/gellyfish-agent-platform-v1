import SwiftUI

@main
struct GellyfishApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @ObservedObject private var pushManager = PushNotificationManager.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            MainTabView()
                .overlay {
                    if let approval = pushManager.pendingApproval {
                        Color.black.opacity(0.4)
                            .ignoresSafeArea()
                            .onTapGesture {} // block taps through
                        ApprovalCardView(
                            approval: approval,
                            onRespond: { state in
                                await pushManager.respondToApproval(
                                    id: approval.id,
                                    state: state,
                                    userInfo: approval.userInfo
                                )
                            },
                            onDismiss: {
                                pushManager.pendingApproval = nil
                            }
                        )
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .animation(.spring(duration: 0.3), value: pushManager.pendingApproval?.id)
                .onChange(of: scenePhase) { _, newPhase in
                    if newPhase == .active {
                        // Refresh the server-authoritative pending list first so
                        // stale cards from prior runs are evicted before anything
                        // else depends on list state (#743). Then drain any
                        // queued APPROVE action — processPendingApprovalAction
                        // also refreshes, but running it here up-front clears
                        // stale cards even when no queued action exists.
                        Task {
                            await pushManager.refreshPendingApprovals()
                            await pushManager.processPendingApprovalAction()
                        }
                    }
                }
        }
    }
}
