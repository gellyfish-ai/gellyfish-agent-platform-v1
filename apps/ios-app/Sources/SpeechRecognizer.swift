import Foundation
import Speech
import AVFoundation

class SpeechRecognizer: ObservableObject {
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()
    private var onTranscript: ((String) -> Void)?
    private var lastTranscript = ""

    // Silence detection
    var onSilenceDetected: (() -> Void)?
    var silenceThreshold: TimeInterval = 2.0
    private var silenceTimer: Timer?
    private var countdownTimer: Timer?
    private var silenceStart: Date?

    /// Progress from 0.0 (just spoke) to 1.0 (silence threshold reached).
    /// UI can bind to this for a countdown arc around the mic button.
    @Published var silenceProgress: Float = 0.0
    @Published var isListening = false

    private static let languageMap: [String: String] = [
        "en": "en-US",
        "es": "es-ES",
        "ca": "ca-ES",
        "ja": "ja-JP",
    ]

    func start(language: String, onTranscript: @escaping (String) -> Void) {
        self.onTranscript = onTranscript
        lastTranscript = ""
        silenceProgress = 0.0

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard status == .authorized else {
                print("[SpeechRecognizer] Speech recognition not authorized: \(status.rawValue)")
                return
            }
            DispatchQueue.main.async {
                self?.startEngine(language: language)
            }
        }
    }

    private func startEngine(language: String) {
        stopEngine()

        let locale = Self.languageMap[language] ?? "en-US"
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
              recognizer.isAvailable else {
            print("[SpeechRecognizer] Recognizer not available for \(locale)")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.recognitionRequest = request

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            print("[SpeechRecognizer] Audio session error: \(error)")
            return
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            print("[SpeechRecognizer] Audio engine error: \(error)")
            return
        }

        isListening = true

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }

            if let result = result {
                self.lastTranscript = result.bestTranscription.formattedString
                // Reset silence timer on each new partial result
                self.resetSilenceTimer()
            }

            if error != nil || (result?.isFinal ?? false) {
                self.cancelSilenceTimers()
                self.stopEngine()
                DispatchQueue.main.async {
                    self.isListening = false
                    self.silenceProgress = 0.0
                }
                if !self.lastTranscript.isEmpty {
                    self.onTranscript?(self.lastTranscript)
                }
            }
        }

        // Start initial silence timer (user may not speak immediately)
        resetSilenceTimer()
    }

    func stop() {
        cancelSilenceTimers()
        recognitionRequest?.endAudio()
        // The recognition task's completion handler will fire and call onTranscript
    }

    private func stopEngine() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
    }

    // MARK: - Silence Detection

    private func resetSilenceTimer() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.cancelSilenceTimers()
            self.silenceProgress = 0.0
            self.silenceStart = Date()

            // Main timer: fires after silenceThreshold
            self.silenceTimer = Timer.scheduledTimer(withTimeInterval: self.silenceThreshold, repeats: false) { [weak self] _ in
                guard let self = self else { return }
                self.cancelSilenceTimers()
                self.silenceProgress = 1.0
                // Only trigger silence if we have a transcript
                if !self.lastTranscript.isEmpty {
                    self.onSilenceDetected?()
                }
            }

            // Countdown timer: updates progress every 50ms for smooth animation
            self.countdownTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                guard let self = self, let start = self.silenceStart else { return }
                let elapsed = Date().timeIntervalSince(start)
                let progress = min(Float(elapsed / self.silenceThreshold), 1.0)
                self.silenceProgress = progress
            }
        }
    }

    private func cancelSilenceTimers() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        countdownTimer?.invalidate()
        countdownTimer = nil
        silenceStart = nil
    }
}
