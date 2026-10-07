import Foundation
import LocalAuthentication
import UIKit
import UserNotifications
import os.log

@MainActor
class PushNotificationManager: NSObject, ObservableObject {
    static let shared = PushNotificationManager()
    private static let logger = Logger(subsystem: "com.gellyfish.GellyfishApp", category: "approval")

    private static let registeredKey = "pushIsRegistered"
    private static let tokenKey = "pushDeviceToken"

    @Published var isRegistered: Bool = UserDefaults.standard.bool(forKey: "pushIsRegistered") {
        didSet { UserDefaults.standard.set(isRegistered, forKey: Self.registeredKey) }
    }
    @Published var deviceToken: String? = UserDefaults.standard.string(forKey: "pushDeviceToken") {
        didSet { UserDefaults.standard.set(deviceToken, forKey: Self.tokenKey) }
    }
    /// Server-authoritative list of pending approval cards (#743).
    ///
    /// The source of truth is the gateway's `/api/approvals/pending` endpoint.
    /// On app foreground we fetch the server list and drop any local card
    /// whose id isn't returned — that's how stale cards from prior runs get
    /// evicted. Pushes append new entries (deduped by id). Respond success
    /// removes the entry optimistically; failure triggers a refresh.
    ///
    /// Full push payload (nonce, action_hash) is retained on each entry so
    /// we can still sign the approval when the user taps approve.
    @Published var pendingApprovals: [ApprovalPayload] = []

    /// Convenience — the oldest pending approval, or nil if none. The single
    /// card overlay in GellyfishApp renders this one.
    var pendingApproval: ApprovalPayload? {
        get { pendingApprovals.first }
        set {
            if let v = newValue {
                upsertPendingApproval(v)
            } else {
                pendingApprovals.removeAll()
            }
        }
    }

    /// Queued APPROVE action from a notification tap.
    ///
    /// Background: iOS 17+ does NOT guarantee the app is `.active` when a
    /// `.foreground` notification action handler runs — it runs during the
    /// inactive→active transition. LAContext refuses to present biometrics in
    /// a non-active context and fails with "User interaction required" (#735).
    ///
    /// Fix: the notification handler just queues the action and returns. A
    /// scenePhase observer (in GellyfishApp) drains the queue once the scene
    /// reaches `.active`, where LAContext works.
    @Published var pendingApprovalAction: PendingApprovalAction?

    /// Actions older than this are dropped on scenePhase .active — stale.
    private static let pendingActionTTL: TimeInterval = 60

    private static let deviceIdKey = "registeredDeviceId"
    var deviceId: String? {
        get { UserDefaults.standard.string(forKey: Self.deviceIdKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.deviceIdKey) }
    }

    private static let pairedKey = "deviceIsPaired"
    @Published var isPaired: Bool = UserDefaults.standard.bool(forKey: "deviceIsPaired") {
        didSet { UserDefaults.standard.set(isPaired, forKey: Self.pairedKey) }
    }

    private var serverURL: String {
        UserDefaults.standard.string(forKey: "serverURL") ?? "http://10.0.0.1:3000"
    }

    private override init() {
        super.init()
        // Sync paired state with Secure Enclave key presence
        if isPaired && !SecureEnclaveManager.shared.hasKey {
            isPaired = false
        }
    }

    // MARK: - Registration

    func requestPermissionAndRegister() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error {
                print("[Push] Authorization error: \(error.localizedDescription)")
                return
            }
            guard granted else {
                print("[Push] Permission denied")
                return
            }
            DispatchQueue.main.async {
                self.registerCategories()
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func handleDeviceToken(_ tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        isRegistered = true
        Task { await sendTokenToGateway(token: token) }
    }

    func handleRegistrationError(_ error: Error) {
        print("[Push] Registration failed: \(error.localizedDescription)")
        isRegistered = false
    }

    // MARK: - Notification Categories

    private func registerCategories() {
        // iPhone shows both Approve and Reject. Approve uses .foreground to open
        // the app, where Secure Enclave signing can present Face ID (#676, #684).
        // The companion watchOS app (GellyfishWatch) registers the same "approval"
        // category with ZERO actions, overriding this on Watch (#703, #675).
        let approveAction = UNNotificationAction(
            identifier: "APPROVE",
            title: "Approve",
            options: [.authenticationRequired, .foreground]
        )
        let rejectAction = UNNotificationAction(
            identifier: "REJECT",
            title: "Reject",
            options: [.destructive]
        )

        let approvalCategory = UNNotificationCategory(
            identifier: "approval",
            actions: [rejectAction, approveAction],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )

        UNUserNotificationCenter.current().setNotificationCategories([approvalCategory])
    }

    // MARK: - Handle Notification Response (from lock screen / banner)

    func handleNotificationResponse(_ response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo

        let appState = UIApplication.shared.applicationState
        let stateStr = appState == .active ? "active" : appState == .inactive ? "inactive" : "background"
        Self.logger.notice("[676] handleNotificationResponse ENTRY — action=\(response.actionIdentifier) appState=\(stateStr)")

        guard let approvalId = userInfo["approvalId"] as? String else {
            Self.logger.error("[676] handleNotificationResponse — no approvalId in userInfo, bailing")
            return
        }

        Self.logger.notice("[676] approvalId=\(approvalId) isPaired=\(self.isPaired) hasKey=\(SecureEnclaveManager.shared.hasKey)")

        // Tell iOS we need time to finish the HTTP POST.
        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ApprovalResponse") {
            Self.logger.error("[676] Background task EXPIRED before approval POST completed for \(approvalId)")
            UIApplication.shared.endBackgroundTask(bgTaskId)
            bgTaskId = .invalid
        }
        let bgTimeRemaining = UIApplication.shared.backgroundTimeRemaining
        Self.logger.notice("[676] beginBackgroundTask acquired, backgroundTimeRemaining=\(bgTimeRemaining, format: .fixed(precision: 1))s")
        defer {
            if bgTaskId != .invalid {
                Self.logger.notice("[676] endBackgroundTask for \(approvalId)")
                UIApplication.shared.endBackgroundTask(bgTaskId)
            }
        }

        switch response.actionIdentifier {
        case "APPROVE":
            // Don't touch LAContext here — iOS 17+ runs this handler before
            // scenePhase .active, and LAContext fails with "User interaction
            // required" (#735). Queue the action and let the scenePhase
            // observer drain it once the app is truly active.
            Self.logger.notice("[735] Queueing APPROVE for \(approvalId) — will process on scenePhase .active")
            pendingApprovalAction = PendingApprovalAction(
                approvalId: approvalId,
                state: "approved",
                userInfo: userInfo,
                queuedAt: Date()
            )
            // If we're already active (rare — willPresent handles this case),
            // drain immediately. Otherwise the scenePhase observer will.
            if appState == .active {
                await processPendingApprovalAction()
            }
        case "REJECT":
            // Reject has no biometric — safe to fire inline from any state.
            Self.logger.notice("[676] Calling respondToApproval for \(approvalId) state=rejected")
            // Optimistic UI — drop the card before the POST (#743).
            removePendingApproval(id: approvalId)
            let result = await respondToApproval(id: approvalId, state: "rejected", userInfo: userInfo)
            Self.logger.notice("[676] respondToApproval result=\(String(describing: result))")
            if case .failure = result { await refreshPendingApprovals() }
        case UNNotificationDismissActionIdentifier:
            // Dismissing the notification (swipe-away on watchOS/iOS) rejects the
            // approval so the agent isn't blocked for the full TTL (#691).
            Self.logger.notice("[691] Dismiss action — rejecting approval \(approvalId)")
            removePendingApproval(id: approvalId)
            let result = await respondToApproval(id: approvalId, state: "rejected", userInfo: userInfo)
            Self.logger.notice("[691] respondToApproval result=\(String(describing: result))")
            if case .failure = result { await refreshPendingApprovals() }
        default:
            Self.logger.notice("[676] Default tap — showing approval card for \(approvalId)")
            if let payload = ApprovalPayload(from: userInfo) {
                upsertPendingApproval(payload)
            }
        }
    }

    /// Drain a queued APPROVE action. Called by the scenePhase observer when
    /// the scene reaches `.active`, and directly when queuing from an already-active
    /// state. Runs the full biometric + sign + POST flow in the active context.
    ///
    /// No-op if there's no queued action, if it's expired, or if the app isn't
    /// actually active (retry on next transition).
    func processPendingApprovalAction() async {
        guard let action = pendingApprovalAction else { return }

        // Drop stale actions — user likely abandoned after TTL.
        let age = Date().timeIntervalSince(action.queuedAt)
        if age > Self.pendingActionTTL {
            Self.logger.notice("[735] Dropping stale pending action for \(action.approvalId) — age=\(age, format: .fixed(precision: 1))s > TTL")
            pendingApprovalAction = nil
            return
        }

        // Require truly active state — LAContext needs a foreground app.
        let appState = UIApplication.shared.applicationState
        guard appState == .active else {
            Self.logger.notice("[735] processPendingApprovalAction — appState is \(appState == .inactive ? "inactive" : "background"), waiting for .active")
            return
        }

        Self.logger.notice("[735] Processing queued action for \(action.approvalId) — age=\(age, format: .fixed(precision: 1))s")
        // Clear before processing so a second scenePhase change doesn't double-fire.
        pendingApprovalAction = nil

        // Verify the queued approval is still pending on the gateway (#743).
        // If not, the card the user tapped approve on was stale — drop silently.
        await refreshPendingApprovals()
        let stillPending = pendingApprovals.contains { $0.id == action.approvalId }
        if !stillPending {
            Self.logger.notice("[743] Queued action for \(action.approvalId) is no longer pending on gateway — dropping")
            return
        }

        // Optimistic UI — drop the card before the POST.
        removePendingApproval(id: action.approvalId)
        let result = await respondToApproval(
            id: action.approvalId,
            state: action.state,
            userInfo: action.userInfo
        )
        Self.logger.notice("[735] processPendingApprovalAction result=\(String(describing: result))")
        // On failure, resync so the card reappears (the approval might still be pending).
        if case .failure = result { await refreshPendingApprovals() }
    }

    // MARK: - Handle Foreground Notification (show in-app card)

    func handleForegroundNotification(_ notification: UNNotification) -> UNNotificationPresentationOptions {
        let userInfo = notification.request.content.userInfo
        guard notification.request.content.categoryIdentifier == "approval",
              let payload = ApprovalPayload(from: userInfo) else {
            return [.banner, .sound]
        }

        // Append to the card list (deduped by id).
        upsertPendingApproval(payload)
        return [.sound]
    }

    // MARK: - Pending Approvals List (#743)

    /// Add or replace an approval in the card list, keyed by id.
    func upsertPendingApproval(_ payload: ApprovalPayload) {
        if let idx = pendingApprovals.firstIndex(where: { $0.id == payload.id }) {
            pendingApprovals[idx] = payload
        } else {
            pendingApprovals.append(payload)
        }
    }

    /// Remove an approval from the card list. No-op if not present.
    func removePendingApproval(id: String) {
        pendingApprovals.removeAll { $0.id == id }
    }

    /// Rebuild the card list from the gateway's authoritative pending set.
    ///
    /// - Local cards whose id is NOT in the server response are dropped (stale).
    /// - Server cards whose id IS in our local set get their `createdAt`
    ///   updated from the server timestamp (for a correct age indicator).
    /// - Server cards not in local state are NOT added — we need the full
    ///   push payload (nonce, action_hash) to sign; server list lacks those.
    ///   The gateway re-sends the push if the approval is still pending.
    /// - Network failure: log, DO NOT wipe local state (could be a blip).
    func refreshPendingApprovals() async {
        let base = serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(base)/api/approvals/pending") else {
            Self.logger.error("[743] refreshPendingApprovals — invalid server URL: \(base)")
            return
        }

        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                Self.logger.warning("[743] refreshPendingApprovals — non-200 status=\(status), keeping local state")
                return
            }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let approvals = json["approvals"] as? [[String: Any]] else {
                Self.logger.warning("[743] refreshPendingApprovals — malformed response, keeping local state")
                return
            }

            // Build a map from id → server created_at (for age sync).
            var serverIds = Set<String>()
            var serverCreatedAt: [String: Date] = [:]
            for row in approvals {
                guard let id = row["id"] as? String else { continue }
                serverIds.insert(id)
                if let created = row["created_at"] as? String {
                    serverCreatedAt[id] = Self.parseServerDate(created)
                }
            }

            let droppedIds = pendingApprovals.compactMap { serverIds.contains($0.id) ? nil : $0.id }
            if !droppedIds.isEmpty {
                let droppedJoined = droppedIds.joined(separator: ",")
                Self.logger.notice("[743] Dropping \(droppedIds.count) stale card(s): \(droppedJoined)")
            }

            // Keep only cards still in server list. Update createdAt from server.
            pendingApprovals = pendingApprovals.compactMap { card in
                guard serverIds.contains(card.id) else { return nil }
                if let serverDate = serverCreatedAt[card.id] {
                    return card.withCreatedAt(serverDate)
                }
                return card
            }
        } catch {
            Self.logger.warning("[743] refreshPendingApprovals — network error: \(error.localizedDescription), keeping local state")
        }
    }

    /// Parse SQLite `datetime('now')` format: `YYYY-MM-DD HH:MM:SS` (UTC, no tz).
    private static func parseServerDate(_ s: String) -> Date? {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.date(from: s)
    }

    // MARK: - Device Pairing

    @discardableResult
    func initiatePairing() async throws -> String {
        // Generate Secure Enclave key
        let publicKey = try SecureEnclaveManager.shared.generateKeyPair()

        guard let token = deviceToken else {
            throw PairingError.notRegistered
        }

        // Send public key to gateway
        let base = serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(base)/api/devices/pair") else {
            throw PairingError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = [
            "public_key": publicKey,
            "device_token": token,
            "device_name": UIDevice.current.name,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw PairingError.serverError(statusCode)
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let code = json["code"] as? String else {
            throw PairingError.serverError(0)
        }

        // Store device ID from response if present
        if let device = json["device"] as? [String: Any],
           let id = device["id"] as? String {
            deviceId = id
        }

        print("[Push] Pairing initiated, code: \(code)")
        return code
    }

    func confirmPairing(code: String) async throws {
        let base = serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(base)/api/devices/pair/confirm") else {
            throw PairingError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: String] = ["code": code]
        if let id = deviceId {
            body["device_id"] = id
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw PairingError.confirmationFailed(statusCode)
        }

        isPaired = true
        print("[Push] Device paired successfully")
    }

    func unpairDevice() async {
        // Delete Secure Enclave key
        SecureEnclaveManager.shared.deleteKey()

        // Notify gateway — uses same DELETE endpoint as unregister
        if let id = deviceId {
            let base = serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if let url = URL(string: "\(base)/api/devices/\(id)") {
                var request = URLRequest(url: url)
                request.httpMethod = "DELETE"
                do {
                    let (_, _) = try await URLSession.shared.data(for: request)
                } catch {
                    print("[Push] Unpair API error: \(error.localizedDescription)")
                }
            }
        }

        isPaired = false
        print("[Push] Device unpaired, Secure Enclave key deleted")
    }

    // MARK: - API Calls

    @discardableResult
    func respondToApproval(id: String, state: String, userInfo: [AnyHashable: Any]? = nil) async -> ApprovalResponseResult {
        Self.logger.notice("[676] respondToApproval ENTRY — id=\(id) state=\(state) isPaired=\(self.isPaired)")
        let base = serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(base)/api/approvals/\(id)/respond") else {
            Self.logger.error("[676] respondToApproval — invalid server URL: \(base)")
            return .failure("Invalid server URL")
        }

        var body: [String: Any] = ["state": state]

        let info = userInfo ?? pendingApproval?.userInfo
        let nonce = (info?["nonce"] as? String) ?? ""
        let actionHash = (info?["action_hash"] as? String) ?? ""
        let signingPayload = "\(nonce)\(actionHash)\(state.uppercased())"
        let payloadData = signingPayload.data(using: .utf8) ?? Data()
        let mcpName = (info?["mcp"] as? String) ?? (info?["mcp_name"] as? String) ?? "-"
        let toolName = (info?["tool"] as? String) ?? "-"
        let pubkeyHex = (try? SecureEnclaveManager.shared.getPublicKeyBase64())
            .flatMap { Data(base64Encoded: $0)?.hexString }

        // Diagnostic entry is created up-front and updated as stages complete.
        // This way the row always reflects actual outcome, not the user's
        // intent at tap time (#735).
        let intent = (state == "approved") ? "approve" : "reject"
        let diagnosticId = SignDiagnosticsStore.shared.record(SignDiagnosticEntry(
            id: UUID(),
            timestamp: Date(),
            approvalId: id,
            mcpName: mcpName,
            toolName: toolName,
            payloadHex: payloadData.hexString,
            pubkeyHex: pubkeyHex,
            nonceHex: nonce,
            actionHashHex: actionHash,
            actionIntent: intent,
            lacontextResult: "not_attempted",
            postResult: "not_attempted",
            finalOutcome: "pending",
            signatureHex: nil,
            httpStatus: nil,
            httpBody: nil
        ))

        // Only approvals need Secure Enclave signing. Rejects are accepted
        // unsigned by the gateway (#697).
        if state == "approved", isPaired, info != nil {
            guard signingPayload.data(using: .utf8) != nil else {
                return .failure("Failed to encode signing payload")
            }

            let appStateStr = UIApplication.shared.applicationState == .active ? "active" : UIApplication.shared.applicationState == .inactive ? "inactive" : "background"
            Self.logger.notice("[676] About to call SecureEnclaveManager.sign() — appState=\(appStateStr)")

            // Pre-evaluate LAContext so SecKeyCreateSignature reuses the existing
            // device-unlock auth instead of presenting its own Face ID prompt.
            // Must only run when scenePhase is .active — notification-action
            // handlers MUST queue the action and wait for .active (#735).
            let context = LAContext()
            do {
                try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Approve tool action")
                Self.logger.notice("[676] LAContext evaluatePolicy SUCCEEDED")
                SignDiagnosticsStore.shared.updateLAContextResult(id: diagnosticId, result: "succeeded")
            } catch {
                let reason = Self.lacontextReason(from: error)
                Self.logger.error("[735] LAContext FAILED — reason=\(reason) error=\(error.localizedDescription)")
                SignDiagnosticsStore.shared.updateLAContextResult(
                    id: diagnosticId,
                    result: "failed_\(reason)"
                )
                if reason == "user_interaction_required" {
                    // Shouldn't happen now that we defer to scenePhase .active,
                    // but if it does, the user can retry from the in-app card.
                    return .failure("Authentication unavailable — reopen the app to approve.")
                }
                return .failure("Authentication failed: \(error.localizedDescription)")
            }

            do {
                let signature = try SecureEnclaveManager.shared.sign(data: payloadData, context: context)
                body["signature"] = signature
                body["device_id"] = deviceId
                SignDiagnosticsStore.shared.updateSignature(
                    id: diagnosticId,
                    signatureHex: Data(base64Encoded: signature)?.hexString
                )
                Self.logger.notice("[676] SecureEnclave sign SUCCEEDED — signature length=\(signature.count) chars")
                print("[Push] Approval signed with Secure Enclave")
            } catch SecureEnclaveError.biometricCancelled {
                SignDiagnosticsStore.shared.updateLAContextResult(
                    id: diagnosticId,
                    result: "failed_biometric_cancelled"
                )
                Self.logger.warning("[676] SecureEnclave sign — BIOMETRIC CANCELLED")
                print("[Push] Biometric cancelled — not sending approval")
                return .cancelled
            } catch {
                SignDiagnosticsStore.shared.updateLAContextResult(
                    id: diagnosticId,
                    result: "failed_\(error.localizedDescription)"
                )
                Self.logger.error("[676] SecureEnclave sign FAILED — error=\(error.localizedDescription)")
                print("[Push] Signing error: \(error.localizedDescription)")
                return .failure("Signing failed: \(error.localizedDescription)")
            }
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 15

        Self.logger.notice("[676] About to POST \(url.absoluteString) — body keys=\(Array(body.keys).joined(separator: ","))")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let bodyString = String(data: data, encoding: .utf8) ?? ""
            Self.logger.notice("[676] HTTP POST completed — status=\(status) bodyLength=\(bodyString.count)")
            SignDiagnosticsStore.shared.updatePostResult(id: diagnosticId, status: status, body: bodyString)
            if status == 200 {
                print("[Push] Approval \(id) \(state) succeeded")
                // Optimistic UI: drop the card from the list (#743).
                // Reject path already removed it pre-POST in handleNotificationResponse;
                // approve path removes it here for the in-app-card flow.
                removePendingApproval(id: id)
                return .success
            }
            Self.logger.error("[676] HTTP POST non-200 — status=\(status) body=\(bodyString)")
            print("[Push] Approval response failed: status=\(status) body=\(bodyString)")
            let detail = Self.parseErrorMessage(from: data) ?? "HTTP \(status)"
            return .failure("\(detail) (\(status))")
        } catch {
            Self.logger.error("[676] HTTP POST FAILED — error=\(error.localizedDescription)")
            SignDiagnosticsStore.shared.updatePostResult(
                id: diagnosticId,
                status: nil,
                body: "network error: \(error.localizedDescription)"
            )
            print("[Push] Approval error: \(error.localizedDescription)")
            return .failure(error.localizedDescription)
        }
    }

    /// Summarize an LAContext error into a short diagnostic slug.
    ///
    /// Uses raw NSError code because not every LAError case is exposed as a
    /// Swift enum case across SDK versions. In particular, -1008
    /// (userInteractionRequired) — the one #735 is about — isn't always
    /// present as `LAError.Code.userInteractionRequired`.
    private static func lacontextReason(from error: Error) -> String {
        let ns = error as NSError
        guard ns.domain == LAErrorDomain else { return "unknown" }
        switch ns.code {
        case -1: return "authentication_failed"  // LAError.authenticationFailed
        case -2: return "user_cancel"
        case -3: return "user_fallback"
        case -4: return "system_cancel"
        case -5: return "passcode_not_set"
        case -6: return "biometry_not_available"
        case -7: return "biometry_not_enrolled"
        case -8: return "biometry_lockout"
        case -9: return "app_cancel"
        case -10: return "invalid_context"
        case -1004: return "not_interactive"
        case -1008: return "user_interaction_required"
        default: return "lacontext_\(ns.code)"
        }
    }

    private static func parseErrorMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return (json["error"] as? String) ?? (json["message"] as? String)
    }

    private func sendTokenToGateway(token: String) async {
        let base = serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(base)/api/devices/register") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = [
            "device_token": token,
            "device_name": UIDevice.current.name,
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let device = json["device"] as? [String: Any],
                   let id = device["id"] as? String {
                    deviceId = id
                }
                print("[Push] Device registered with gateway (id: \(deviceId ?? "unknown"))")
            }
        } catch {
            print("[Push] Token registration error: \(error.localizedDescription)")
        }
    }

    func unregisterDevice() async {
        guard let id = deviceId else { return }
        let base = serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(base)/api/devices/\(id)") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"

        do {
            let (_, _) = try await URLSession.shared.data(for: request)
            // Also clean up Secure Enclave key if paired
            if isPaired {
                SecureEnclaveManager.shared.deleteKey()
                isPaired = false
            }
            isRegistered = false
            deviceToken = nil
            deviceId = nil
            UIApplication.shared.unregisterForRemoteNotifications()
            print("[Push] Device unregistered")
        } catch {
            print("[Push] Unregister error: \(error.localizedDescription)")
        }
    }
}

// MARK: - Pairing Errors

enum PairingError: LocalizedError {
    case notRegistered
    case invalidURL
    case serverError(Int)
    case confirmationFailed(Int)

    var errorDescription: String? {
        switch self {
        case .notRegistered:
            return "Device must be registered for push notifications before pairing"
        case .invalidURL:
            return "Invalid server URL"
        case .serverError(let code):
            return "Server error during pairing (HTTP \(code))"
        case .confirmationFailed(let code):
            return "Pairing confirmation failed (HTTP \(code))"
        }
    }
}

// MARK: - Pending Approval Action (notification-action queue)

/// An APPROVE action tapped on a notification that's waiting for the app to
/// reach scenePhase `.active` before running LAContext + signing (#735).
struct PendingApprovalAction {
    let approvalId: String
    let state: String
    let userInfo: [AnyHashable: Any]
    let queuedAt: Date
}

// MARK: - Approval Response Result

enum ApprovalResponseResult {
    case success
    case cancelled           // User cancelled Face ID — no error, just re-enable the buttons
    case failure(String)     // User-facing error message to show inline on the card
}

// MARK: - Approval Payload

struct ApprovalPayload: Identifiable {
    let id: String
    let agentName: String
    let profileName: String
    let tool: String
    let summary: String
    let ttl: TimeInterval
    var createdAt: Date
    let userInfo: [AnyHashable: Any]

    var expiresAt: Date { createdAt.addingTimeInterval(ttl) }
    var isExpired: Bool { Date() > expiresAt }

    /// Age of this approval (seconds since created_at). Used by the card UI
    /// to show "Ns ago" and a staleness indicator if > 60s (#743).
    var ageSeconds: TimeInterval { Date().timeIntervalSince(createdAt) }

    init?(from userInfo: [AnyHashable: Any]) {
        guard let approvalId = userInfo["approvalId"] as? String else { return nil }
        self.id = approvalId

        let agentName = userInfo["agentName"] as? String
        let profileName = userInfo["profileName"] as? String
        let tool = userInfo["tool"] as? String

        self.agentName = agentName ?? "(unknown agent)"
        self.profileName = profileName ?? "(unknown profile)"
        self.tool = tool ?? "(unknown action)"
        self.summary = userInfo["summary"] as? String ?? ""
        self.ttl = (userInfo["ttl"] as? TimeInterval) ?? 120
        self.createdAt = Date()
        self.userInfo = userInfo

        if agentName == nil || profileName == nil || tool == nil {
            let missing = [
                agentName == nil ? "agentName" : nil,
                profileName == nil ? "profileName" : nil,
                tool == nil ? "tool" : nil,
            ].compactMap { $0 }.joined(separator: ", ")
            print("[Push] ApprovalPayload missing fields from gateway: \(missing) — gateway emits Change A since #658")
        }
    }

    /// Return a copy with the server-provided createdAt. Used to correct the
    /// local timestamp (which defaults to push-arrival time) against the real
    /// gateway-side creation time after refreshPendingApprovals (#743).
    func withCreatedAt(_ date: Date) -> ApprovalPayload {
        var copy = self
        copy.createdAt = date
        return copy
    }
}
