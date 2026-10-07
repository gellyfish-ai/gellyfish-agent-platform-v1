import AVFoundation

class TTSManager: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()

    var onStarted: (() -> Void)?
    var onFinished: (() -> Void)?

    @Published var isSpeaking = false

    private static let languageMap: [String: String] = [
        "en": "en-US",
        "es": "es-ES",
        "ca": "ca-ES",
        "ja": "ja-JP",
    ]

    enum Speed: Float {
        case slow = 0.4
        case normal = 0.5
        case fast = 0.6
    }

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(text: String, language: String = "en", speed: Float = Speed.normal.rawValue) {
        stop()

        let cleaned = Self.stripMarkdown(text)
        guard !cleaned.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        let locale = Self.languageMap[language] ?? "en-US"
        let utterance = AVSpeechUtterance(string: cleaned)
        utterance.voice = AVSpeechSynthesisVoice(language: locale)
        utterance.rate = speed
        utterance.pitchMultiplier = 1.0

        synthesizer.speak(utterance)
    }

    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }

    // MARK: - AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in
            self?.isSpeaking = true
            self?.onStarted?()
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in
            self?.isSpeaking = false
            self?.onFinished?()
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in
            self?.isSpeaking = false
            self?.onFinished?()
        }
    }

    // MARK: - Markdown Stripping

    static func stripMarkdown(_ text: String) -> String {
        var result = text

        // Remove fenced code blocks (```...```)
        result = result.replacingOccurrences(
            of: "```[\\s\\S]*?```",
            with: "",
            options: .regularExpression
        )

        // Remove inline code (`...`)
        result = result.replacingOccurrences(
            of: "`([^`]+)`",
            with: "$1",
            options: .regularExpression
        )

        // Remove markdown links [text](url) → text
        result = result.replacingOccurrences(
            of: "\\[([^\\]]+)\\]\\([^)]+\\)",
            with: "$1",
            options: .regularExpression
        )

        // Remove bold **text** or __text__ → text
        result = result.replacingOccurrences(
            of: "\\*\\*([^*]+)\\*\\*",
            with: "$1",
            options: .regularExpression
        )
        result = result.replacingOccurrences(
            of: "__([^_]+)__",
            with: "$1",
            options: .regularExpression
        )

        // Remove italic *text* or _text_ → text
        result = result.replacingOccurrences(
            of: "(?<![*])\\*([^*]+)\\*(?![*])",
            with: "$1",
            options: .regularExpression
        )

        // Process line by line for line-anchored patterns
        result = result.split(separator: "\n", omittingEmptySubsequences: false).map { line in
            var l = String(line)
            // Remove headings
            if let range = l.range(of: "^#{1,6}\\s+", options: .regularExpression) {
                l.removeSubrange(range)
            }
            // Remove horizontal rules
            if l.range(of: "^[-*_]{3,}$", options: .regularExpression) != nil {
                return ""
            }
            // Remove bullet points
            if let range = l.range(of: "^\\s*[-*+]\\s+", options: .regularExpression) {
                l.removeSubrange(range)
            }
            // Remove numbered list markers
            if let range = l.range(of: "^\\s*\\d+\\.\\s+", options: .regularExpression) {
                l.removeSubrange(range)
            }
            // Remove blockquotes
            if let range = l.range(of: "^>\\s*", options: .regularExpression) {
                l.removeSubrange(range)
            }
            return l
        }.joined(separator: "\n")

        // Collapse multiple blank lines
        result = result.replacingOccurrences(
            of: "\n{3,}",
            with: "\n\n",
            options: .regularExpression
        )

        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
