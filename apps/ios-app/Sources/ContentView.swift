import SwiftUI
import WebKit

struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = "http://10.0.0.1:3000"
    @State private var showSettings = false
    @State private var editURL = ""
    @StateObject private var webModel = WebViewModel()

    var body: some View {
        ZStack(alignment: .topTrailing) {
            WebView(viewModel: webModel, urlString: serverURL)
                .ignoresSafeArea(.container, edges: .bottom)

            Button(action: {
                editURL = serverURL
                showSettings = true
            }) {
                Image(systemName: "gear")
                    .font(.system(size: 14))
                    .padding(8)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
            }
            .padding(.trailing, 12)
            .padding(.top, 50)
        }
        .sheet(isPresented: $showSettings) {
            NavigationView {
                Form {
                    Section("Server Address") {
                        TextField("URL", text: $editURL)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .keyboardType(.URL)
                    }
                }
                .navigationTitle("Settings")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showSettings = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            serverURL = editURL
                            webModel.load(urlString: serverURL)
                            showSettings = false
                        }
                    }
                }
            }
        }
        .onAppear {
            webModel.load(urlString: serverURL)
        }
    }
}

// MARK: - WKWebView wrapper

struct WebView: UIViewRepresentable {
    let viewModel: WebViewModel
    let urlString: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // Register JavaScript bridge
        let handler = viewModel
        config.userContentController.add(handler, name: "gellyfish")

        // Inject bridge setup script
        let bridgeScript = WKUserScript(
            source: """
            window.gellyfish = window.gellyfish || {};
            window.gellyfish._nativeApp = true;
            document.addEventListener('DOMContentLoaded', () => {
                document.body.classList.add('native-app');
                // Native long-press context menu for messages
                let pressTimer = null;
                let pressTarget = null;
                document.addEventListener('touchstart', (e) => {
                    const msg = e.target.closest('.message');
                    if (!msg) return;
                    pressTarget = msg;
                    pressTimer = setTimeout(() => {
                        const messageId = msg.dataset.messageId || '';
                        const role = msg.classList.contains('user') ? 'user' : 'assistant';
                        const clone = msg.cloneNode(true);
                        clone.querySelectorAll('.reply-btn, .reactions, .reaction-bar, .message-timestamp, .message-quote, .reaction-trigger, .reaction-badge').forEach(el => el.remove());
                        const text = (clone.textContent || '').replace(/\\s+/g, ' ').trim();
                        const existingBadge = msg.querySelector('.reaction-badge');
                        const currentEmoji = existingBadge ? existingBadge.textContent : '';
                        window.webkit.messageHandlers.gellyfish.postMessage({
                            action: 'messageContextMenu',
                            messageId: messageId,
                            role: role,
                            text: text.substring(0, 200),
                            currentEmoji: currentEmoji
                        });
                        pressTimer = null;
                    }, 500);
                }, { passive: true });
                document.addEventListener('touchend', () => { clearTimeout(pressTimer); pressTimer = null; });
                document.addEventListener('touchmove', () => { clearTimeout(pressTimer); pressTimer = null; });
            });
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(bridgeScript)

        // Allow HTTP (non-HTTPS) for local network
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = viewModel
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.bounces = false

        viewModel.webView = webView
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
