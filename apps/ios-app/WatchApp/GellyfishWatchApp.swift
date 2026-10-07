import SwiftUI
import UserNotifications
import WatchKit

@main
struct GellyfishWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) var delegate

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 12) {
                Text("🪼")
                    .font(.system(size: 48))
                Text("Gellyfish")
                    .font(.headline)
                Text("Notifications appear here.\nApprove or deny on iPhone.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding()
        }
    }
}

class WatchAppDelegate: NSObject, WKApplicationDelegate {
    func applicationDidFinishLaunching() {
        // Register the "approval" category with ZERO actions.
        // This overrides the mirrored iPhone category on Watch,
        // so Watch shows the notification content but no Approve/Reject
        // buttons. The user must act on iPhone where Secure Enclave
        // signing is available (#703, #675).
        let approvalCategory = UNNotificationCategory(
            identifier: "approval",
            actions: [],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([approvalCategory])
    }
}
