import UIKit
import UserNotifications
import os.log

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private static let logger = Logger(subsystem: "com.gellyfish.GellyfishApp", category: "approval")

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let appState = application.applicationState
        let stateStr = appState == .active ? "active" : appState == .inactive ? "inactive" : "background"
        Self.logger.notice("[676] didFinishLaunchingWithOptions — appState=\(stateStr) launchOptions=\(String(describing: launchOptions))")
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    // MARK: - Push Token

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            PushNotificationManager.shared.handleDeviceToken(deviceToken)
        }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in
            PushNotificationManager.shared.handleRegistrationError(error)
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Foreground notification — show in-app approval card instead of banner
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        return await PushNotificationManager.shared.handleForegroundNotification(notification)
    }

    /// User tapped notification action (Approve/Reject) or the notification itself
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        let appState = UIApplication.shared.applicationState
        let stateStr = appState == .active ? "active" : appState == .inactive ? "inactive" : "background"
        Self.logger.notice("[676] userNotificationCenter(didReceive:) ENTRY — action=\(response.actionIdentifier) appState=\(stateStr) category=\(response.notification.request.content.categoryIdentifier)")
        await PushNotificationManager.shared.handleNotificationResponse(response)
        Self.logger.notice("[676] userNotificationCenter(didReceive:) EXIT — handler completed")
    }
}
