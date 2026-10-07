import Foundation
import WebKit
import UIKit

class WebViewModel: NSObject, ObservableObject, WKNavigationDelegate, WKScriptMessageHandler {
    weak var webView: WKWebView?
    private let speechRecognizer = SpeechRecognizer()
    private var foregroundObserver: NSObjectProtocol?

    // Callbacks for bridge messages
    var onOpenSession: ((String, String, String) -> Void)?
    var onResponseComplete: ((String) -> Void)?
    var onMessageContextMenu: ((String, String, String, String) -> Void)?  // messageId, role, text, currentEmoji

    override init() {
        super.init()
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self?.reconnectWebSocket()
            }
        }
    }

    deinit {
        if let observer = foregroundObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - WebSocket Reconnection

    private func reconnectWebSocket() {
        let js = """
        (async () => {
            const { state } = await import('/js/state.js');
            // Force reset — don't trust WebSocket state after iOS suspension
            state.connectingInProgress = false;
            if (state.ws) {
                try { state.ws.close(); } catch {}
                state.ws = null;
            }
            const { connect, connLog } = await import('/js/connection.js');
            connLog('iOS app foregrounded — force reconnecting...');
            connect(state.sessionId || state.resumeSessionId);
        })();
        """
        webView?.evaluateJavaScript(js) { _, error in
            if let error = error {
                print("[WebViewModel] reconnect error: \(error.localizedDescription)")
            }
        }
    }

    func load(urlString: String) {
        guard let url = URL(string: urlString) else { return }
        webView?.load(URLRequest(url: url))
    }

    // MARK: - WKScriptMessageHandler (JavaScript → Native)

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "gellyfish",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        switch action {
        case "startRecording":
            let language = body["language"] as? String ?? "en"
            startRecording(language: language)
        case "stopRecording":
            stopRecording()
        case "responseComplete":
            let text = body["text"] as? String ?? ""
            DispatchQueue.main.async { [weak self] in
                self?.onResponseComplete?(text)
            }
        case "openSession":
            let sessionId = body["sessionId"] as? String ?? ""
            let agentName = body["agentName"] as? String ?? ""
            let agentIcon = body["agentIcon"] as? String ?? ""
            DispatchQueue.main.async { [weak self] in
                self?.onOpenSession?(sessionId, agentName, agentIcon)
            }
        case "messageContextMenu":
            let messageId = body["messageId"] as? String ?? ""
            let role = body["role"] as? String ?? ""
            let text = body["text"] as? String ?? ""
            let currentEmoji = body["currentEmoji"] as? String ?? ""
            DispatchQueue.main.async { [weak self] in
                self?.onMessageContextMenu?(messageId, role, text, currentEmoji)
            }
        default:
            break
        }
    }

    // MARK: - Send Message (Native → Web)

    func sendMessage(_ text: String) {
        let escaped = text
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
        webView?.evaluateJavaScript("window.gellyfish.sendMessage('\(escaped)')") { _, error in
            if let error = error {
                print("[WebViewModel] sendMessage error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Attach Image (Native → Web)

    func attachImage(_ base64: String, mimeType: String) {
        webView?.evaluateJavaScript("window.gellyfish.attachImage('\(base64)', '\(mimeType)')") { _, error in
            if let error = error {
                print("[WebViewModel] attachImage error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Send Message with Images (Native → Web)

    func sendMessageWithImages(_ text: String, images: [(base64: String, mimeType: String)]) {
        let escapedText = text
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")

        // Build image blocks JSON array
        let imageBlocks = images.map { img in
            "{ type: 'image', source: { type: 'base64', media_type: '\(img.mimeType)', data: '\(img.base64)' } }"
        }.joined(separator: ",\n                ")

        let js = """
        (async () => {
            const { default: state } = await import('/js/state.js');
            const { addMessage } = await import('/js/messages.js');
            if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
            const content = [
                \(imageBlocks)
            ];
            const text = '\(escapedText)';
            if (text) content.push({ type: 'text', text: text });
            addMessage(content, 'user', false, null, new Date().toISOString());
            state.ws.send(JSON.stringify({ type: 'user_message', content: content }));
        })();
        """
        webView?.evaluateJavaScript(js) { _, error in
            if let error = error {
                print("[WebViewModel] sendMessageWithImages error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Reply to Message (Native → Web)

    func replyToMessage(messageId: String) {
        let js = """
        (async () => {
            const msgEl = document.querySelector('[data-message-id="\(messageId)"]');
            if (!msgEl) return;
            const { setQuoteTarget } = await import('/js/quote.js');
            setQuoteTarget(msgEl);
        })();
        """
        webView?.evaluateJavaScript(js) { _, error in
            if let error = error {
                print("[WebViewModel] replyToMessage error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - React to Message (Native → Web)

    func reactToMessage(messageId: String, emoji: String, messagePreview: String) {
        let escapedPreview = messagePreview
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
        let js = """
        (async () => {
            const { default: state } = await import('/js/state.js');
            if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
            state.ws.send(JSON.stringify({
                type: 'reaction',
                emoji: '\(emoji)' || null,
                messageId: '\(messageId)',
                messagePreview: '\(escapedPreview)'
            }));
            // Update badge visually
            const msgEl = document.querySelector('[data-message-id="\(messageId)"]');
            if (msgEl) {
                const existing = msgEl.querySelector('.reaction-badge');
                if (existing) existing.remove();
                if ('\(emoji)') {
                    const badge = document.createElement('span');
                    badge.className = 'reaction-badge';
                    badge.dataset.messageId = '\(messageId)';
                    badge.textContent = '\(emoji)';
                    msgEl.appendChild(badge);
                }
            }
        })();
        """
        webView?.evaluateJavaScript(js) { _, error in
            if let error = error {
                print("[WebViewModel] reactToMessage error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Recording

    private func startRecording(language: String) {
        speechRecognizer.start(language: language) { [weak self] transcript in
            DispatchQueue.main.async {
                self?.sendTranscript(transcript)
            }
        }
    }

    private func stopRecording() {
        speechRecognizer.stop()
    }

    private func sendTranscript(_ text: String) {
        let escaped = text
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
        webView?.evaluateJavaScript("window.gellyfish.onTranscript('\(escaped)')") { _, error in
            if let error = error {
                print("[WebViewModel] JS callback error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(.allow)
    }

    // Allow HTTP (non-HTTPS) loads
    func webView(_ webView: WKWebView,
                 didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(.performDefaultHandling, nil)
    }
}
