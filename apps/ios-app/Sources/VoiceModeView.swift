import SwiftUI

struct VoiceModeView: View {
    let webModel: WebViewModel
    let onExitVoiceMode: () -> Void
    @Binding var agentResponseText: String?

    @AppStorage("voice-language") private var language = "en"
    @AppStorage("speech-speed") private var speechSpeed = "normal"
    @AppStorage("auto-listen") private var autoListen = true

    @StateObject private var speechRecognizer = SpeechRecognizer()
    @StateObject private var ttsManager = TTSManager()

    @State private var voiceState: VoiceState = .idle
    @State private var transcript = ""
    @State private var speakerEnabled = true

    private let languages = [
        ("en", "EN"),
        ("es", "ES"),
        ("ca", "CA"),
        ("ja", "JA"),
    ]

    enum VoiceState {
        case idle
        case listening
        case sending
        case responding
    }

    var body: some View {
        VStack(spacing: 0) {
            // Transcript area
            transcriptArea

            Spacer()

            // Big mic button with countdown arc
            micButton

            Spacer()

            // Bottom controls
            bottomControls
        }
        .padding()
        .background(.bar)
        .onAppear { setupCallbacks() }
        .onDisappear {
            speechRecognizer.stop()
            ttsManager.stop()
        }
        .onChange(of: agentResponseText) { _, newValue in
            if let text = newValue {
                handleAgentResponse(text)
                agentResponseText = nil
            }
        }
    }

    // MARK: - Transcript Area

    private var transcriptArea: some View {
        ScrollView {
            Text(transcriptText)
                .font(.body)
                .foregroundStyle(voiceState == .idle ? .secondary : .primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
        .frame(maxHeight: 120)
    }

    private var transcriptText: String {
        switch voiceState {
        case .idle:
            return "Tap to speak"
        case .listening:
            return transcript.isEmpty ? "Listening..." : transcript
        case .sending:
            return "Sending..."
        case .responding:
            return transcript.isEmpty ? "Agent is responding..." : transcript
        }
    }

    // MARK: - Mic Button

    private var micButton: some View {
        ZStack {
            // Countdown arc (silence progress)
            if voiceState == .listening {
                Circle()
                    .trim(from: 0, to: CGFloat(speechRecognizer.silenceProgress))
                    .stroke(Color.orange, lineWidth: 4)
                    .rotationEffect(.degrees(-90))
                    .frame(width: 96, height: 96)
                    .animation(.linear(duration: 0.05), value: speechRecognizer.silenceProgress)
            }

            // Pulse animation when listening
            if voiceState == .listening {
                Circle()
                    .fill(micColor.opacity(0.2))
                    .frame(width: 100, height: 100)
                    .scaleEffect(voiceState == .listening ? 1.15 : 1.0)
                    .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true), value: voiceState)
            }

            Button {
                handleMicTap()
            } label: {
                Image(systemName: micIcon)
                    .font(.system(size: 32))
                    .foregroundStyle(.white)
                    .frame(width: 80, height: 80)
                    .background(micColor)
                    .clipShape(Circle())
            }
            .disabled(voiceState == .sending)
        }
    }

    private var micColor: Color {
        switch voiceState {
        case .idle: return .gray
        case .listening: return .blue
        case .sending: return .orange
        case .responding: return .green
        }
    }

    private var micIcon: String {
        switch voiceState {
        case .idle: return "mic.fill"
        case .listening: return "mic.fill"
        case .sending: return "arrow.up.circle"
        case .responding: return "speaker.wave.2.fill"
        }
    }

    // MARK: - Bottom Controls

    private var bottomControls: some View {
        HStack(spacing: 24) {
            // Language picker
            Menu {
                ForEach(languages, id: \.0) { code, label in
                    Button(label) { language = code }
                }
            } label: {
                Text(languages.first { $0.0 == language }?.1 ?? "EN")
                    .font(.caption.bold())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.quaternary)
                    .clipShape(Capsule())
            }

            // Keyboard toggle — exit voice mode
            Button {
                onExitVoiceMode()
            } label: {
                Image(systemName: "keyboard")
                    .font(.system(size: 22))
                    .foregroundStyle(.secondary)
            }

            // Speaker toggle
            Button {
                speakerEnabled.toggle()
                if !speakerEnabled { ttsManager.stop() }
            } label: {
                Image(systemName: speakerEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(speakerEnabled ? .blue : .secondary)
            }
        }
        .padding(.top, 8)
    }

    // MARK: - Logic

    private func setupCallbacks() {
        speechRecognizer.onSilenceDetected = { [self] in
            handleSilenceDetected()
        }

        ttsManager.onFinished = { [self] in
            voiceState = autoListen ? .idle : .idle
            transcript = ""
            if autoListen {
                // Small delay before auto-starting next listen
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    if voiceState == .idle {
                        startListening()
                    }
                }
            }
        }
    }

    private func handleMicTap() {
        switch voiceState {
        case .idle:
            startListening()
        case .listening:
            // Manual stop → send immediately
            speechRecognizer.stop()
        case .sending:
            break
        case .responding:
            // Tap to stop TTS
            ttsManager.stop()
            voiceState = .idle
            transcript = ""
        }
    }

    private func startListening() {
        transcript = ""
        voiceState = .listening

        speechRecognizer.start(language: language) { finalTranscript in
            DispatchQueue.main.async {
                transcript = finalTranscript
                sendTranscript(finalTranscript)
            }
        }
    }

    private func handleSilenceDetected() {
        speechRecognizer.stop()
        // The onTranscript callback will fire and call sendTranscript
    }

    private func sendTranscript(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            voiceState = .idle
            return
        }

        voiceState = .sending
        webModel.sendMessage(trimmed)

        // Transition to responding state after a brief delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            if voiceState == .sending {
                voiceState = .responding
            }
        }
    }

    /// Called externally when the agent's response is complete.
    /// ChatView will call this when the bridge receives onResponseComplete.
    func handleAgentResponse(_ responseText: String) {
        transcript = responseText
        voiceState = .responding

        if speakerEnabled {
            let speed: Float
            switch speechSpeed {
            case "slow": speed = TTSManager.Speed.slow.rawValue
            case "fast": speed = TTSManager.Speed.fast.rawValue
            default: speed = TTSManager.Speed.normal.rawValue
            }
            ttsManager.speak(text: responseText, language: language, speed: speed)
        } else {
            // No TTS — go back to idle after showing response briefly
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                voiceState = .idle
                transcript = ""
            }
        }
    }
}
