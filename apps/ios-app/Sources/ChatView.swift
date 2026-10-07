import SwiftUI
import WebKit
import PhotosUI

struct PendingImage {
    let data: Data
    let mimeType: String
}

struct ChatView: View {
    let session: Session
    let agentHealth: AgentHealth?
    let serverURL: String

    @StateObject private var webModel = WebViewModel()
    @State private var messageText = ""
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showInfo = false
    @State private var openedSession: Session?
    @State private var messageHistory: [String] = []
    @State private var historyIndex = -1
    @State private var isVoiceMode = false
    @State private var textViewHeight: CGFloat = PastableTextView.minHeight
    @State private var agentResponseText: String?
    @State private var pendingImages: [PendingImage] = []
    @State private var contextMenuMessageId: String?
    @State private var contextMenuRole: String = ""
    @State private var contextMenuText: String = ""
    @State private var contextMenuCurrentEmoji: String = ""
    @State private var showContextMenu = false
    @State private var showEmojiPicker = false

    var body: some View {
        VStack(spacing: 0) {
            WebView(viewModel: webModel, urlString: embeddedURL)
                .onTapGesture {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                }
                .ignoresSafeArea(.container, edges: .bottom)

            if isVoiceMode {
                VoiceModeView(
                    webModel: webModel,
                    onExitVoiceMode: { isVoiceMode = false },
                    agentResponseText: $agentResponseText
                )
                .frame(height: 280)
            } else {

            // Pending image previews
            if !pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(pendingImages.enumerated()), id: \.offset) { index, pending in
                            if let uiImage = UIImage(data: pending.data) {
                                Image(uiImage: uiImage)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 60, height: 60)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                    .overlay(alignment: .topTrailing) {
                                        Button {
                                            pendingImages.remove(at: index)
                                        } label: {
                                            Image(systemName: "xmark.circle.fill")
                                                .font(.system(size: 18))
                                                .foregroundStyle(.white, .black.opacity(0.6))
                                        }
                                        .offset(x: 6, y: -6)
                                    }
                            }
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 6)
            }

            // Native input bar: 📎 | 🔊 | [Message...] | ➤
            HStack(spacing: 8) {
                PhotosPicker(selection: $selectedPhoto, matching: .images) {
                    Image(systemName: "paperclip")
                        .font(.system(size: 22))
                        .foregroundStyle(.secondary)
                }

                // Voice mode toggle
                Button {
                    isVoiceMode = true
                } label: {
                    Image(systemName: "waveform")
                        .font(.system(size: 22))
                        .foregroundStyle(.secondary)
                }

                PastableTextView(text: $messageText, height: $textViewHeight, placeholder: "Message...") { data, mimeType in
                    if pendingImages.count < 5 {
                        pendingImages.append(PendingImage(data: data, mimeType: mimeType))
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: textViewHeight)

                // History navigation
                if !messageHistory.isEmpty {
                    VStack(spacing: 0) {
                        Button { recallHistory(direction: .up) } label: {
                            Image(systemName: "chevron.up")
                                .font(.system(size: 10, weight: .bold))
                        }
                        Button { recallHistory(direction: .down) } label: {
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10, weight: .bold))
                        }
                    }
                    .foregroundStyle(.secondary)
                }

                Button {
                    sendMessage()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(canSend ? .blue : .gray)
                }
                .disabled(!canSend)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)

            } // end else (text mode)
        }
        .navigationTitle(session.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    Text(session.icon)
                        .font(.system(size: 18))
                    Text(session.displayName)
                        .font(.headline)
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 12) {
                    Button {
                        webModel.load(urlString: embeddedURL)
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    Button {
                        showInfo = true
                    } label: {
                        Image(systemName: "info.circle")
                    }
                }
            }
        }
        .toolbarRole(.editor)
        .onAppear {
            webModel.load(urlString: embeddedURL)
            webModel.onResponseComplete = { text in
                if isVoiceMode {
                    agentResponseText = text
                }
            }
            webModel.onOpenSession = { sessionId, agentName, agentIcon in
                openedSession = Session(
                    id: sessionId,
                    firstMessage: nil,
                    firstReply: nil,
                    lastMessage: nil,
                    lastActivity: nil,
                    messageCount: 0,
                    cwd: nil,
                    profileId: nil,
                    profileName: agentName,
                    profileIcon: agentIcon
                )
            }
            webModel.onMessageContextMenu = { messageId, role, text, currentEmoji in
                contextMenuMessageId = messageId
                contextMenuRole = role
                contextMenuText = text
                contextMenuCurrentEmoji = currentEmoji
                showContextMenu = true
            }
        }
        .onChange(of: selectedPhoto) { _, newItem in
            guard let newItem else { return }
            Task { await handleSelectedPhoto(newItem) }
            selectedPhoto = nil
        }
        .sheet(isPresented: $showInfo) {
            ConversationInfoSheet(
                session: session,
                agentHealth: agentHealth,
                serverURL: serverURL,
                onSessionDeleted: {
                    showInfo = false
                },
                onSessionSwitched: { newSessionId in
                    showInfo = false
                    let newURL = serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    webModel.load(urlString: "\(newURL)/session/\(newSessionId)?embedded")
                }
            )
        }
        .navigationDestination(item: $openedSession) { targetSession in
            ChatView(
                session: targetSession,
                agentHealth: nil,
                serverURL: serverURL
            )
        }
        .confirmationDialog("Message", isPresented: $showContextMenu, titleVisibility: .hidden) {
            Button("Reply") {
                if let id = contextMenuMessageId {
                    webModel.replyToMessage(messageId: id)
                }
            }
            Button("React") {
                showEmojiPicker = true
            }
            Button("Copy") {
                UIPasteboard.general.string = contextMenuText
            }
            if !contextMenuCurrentEmoji.isEmpty {
                Button("Remove \(contextMenuCurrentEmoji)") {
                    if let id = contextMenuMessageId {
                        webModel.reactToMessage(messageId: id, emoji: "", messagePreview: contextMenuText)
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $showEmojiPicker) {
            EmojiPickerView { emoji in
                showEmojiPicker = false
                if !emoji.isEmpty, let id = contextMenuMessageId {
                    webModel.reactToMessage(messageId: id, emoji: emoji, messagePreview: contextMenuText)
                }
            }
            .presentationDetents([.medium])
        }
    }

    // MARK: - Send

    private func sendMessage() {
        let text = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !pendingImages.isEmpty else { return }

        if !pendingImages.isEmpty {
            let images = pendingImages.map { (base64: $0.data.base64EncodedString(), mimeType: $0.mimeType) }
            webModel.sendMessageWithImages(text, images: images)
            pendingImages.removeAll()
        } else {
            webModel.sendMessage(text)
        }

        if !text.isEmpty {
            messageHistory.append(text)
        }
        historyIndex = -1
        messageText = ""
        textViewHeight = PastableTextView.minHeight
    }

    // MARK: - History

    private enum HistoryDirection { case up, down }

    private func recallHistory(direction: HistoryDirection) {
        guard !messageHistory.isEmpty else { return }
        switch direction {
        case .up:
            if historyIndex == -1 {
                historyIndex = messageHistory.count - 1
            } else if historyIndex > 0 {
                historyIndex -= 1
            }
            messageText = messageHistory[historyIndex]
        case .down:
            if historyIndex >= 0 && historyIndex < messageHistory.count - 1 {
                historyIndex += 1
                messageText = messageHistory[historyIndex]
            } else {
                historyIndex = -1
                messageText = ""
            }
        }
    }

    // MARK: - Photo

    private func handleSelectedPhoto(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }

        let mimeType: String
        if let contentType = item.supportedContentTypes.first {
            if contentType.conforms(to: .png) {
                mimeType = "image/png"
            } else if contentType.conforms(to: .gif) {
                mimeType = "image/gif"
            } else {
                mimeType = "image/jpeg"
            }
        } else {
            mimeType = "image/jpeg"
        }

        await MainActor.run {
            if pendingImages.count < 5 {
                pendingImages.append(PendingImage(data: data, mimeType: mimeType))
            }
        }
    }

    // MARK: - Helpers

    private var canSend: Bool {
        !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingImages.isEmpty
    }

    private var embeddedURL: String {
        let base = serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return "\(base)/session/\(session.id)?embedded"
    }

    private var statusColor: Color {
        guard let health = agentHealth else { return .gray }
        if health.isActive { return .green }
        if health.isIdle { return .yellow }
        return .gray
    }
}
