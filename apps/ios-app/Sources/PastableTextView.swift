import SwiftUI
import UIKit

struct PastableTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    var placeholder: String = "Message..."
    var onImagePaste: ((Data, String) -> Void)?

    static let minHeight: CGFloat = 36
    static let maxHeight: CGFloat = 120

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> PastableUITextView {
        let textView = PastableUITextView()
        textView.delegate = context.coordinator
        textView.coordinator = context.coordinator
        textView.onImagePaste = onImagePaste
        textView.font = .preferredFont(forTextStyle: .body)
        textView.isScrollEnabled = false
        textView.textContainerInset = UIEdgeInsets(top: 8, left: 4, bottom: 8, right: 4)
        textView.backgroundColor = .secondarySystemBackground
        textView.layer.cornerRadius = 8
        textView.layer.borderWidth = 0.5
        textView.layer.borderColor = UIColor.separator.cgColor
        textView.setContentHuggingPriority(.defaultLow, for: .horizontal)
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        // Placeholder
        textView.placeholderLabel.text = placeholder
        textView.placeholderLabel.font = .preferredFont(forTextStyle: .body)
        textView.placeholderLabel.textColor = .placeholderText
        textView.placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        textView.addSubview(textView.placeholderLabel)
        NSLayoutConstraint.activate([
            textView.placeholderLabel.topAnchor.constraint(equalTo: textView.topAnchor, constant: 8),
            textView.placeholderLabel.leadingAnchor.constraint(equalTo: textView.leadingAnchor, constant: 8),
        ])

        return textView
    }

    func updateUIView(_ textView: PastableUITextView, context: Context) {
        if textView.text != text {
            textView.text = text
        }
        textView.placeholderLabel.isHidden = !text.isEmpty
    }

    class Coordinator: NSObject, UITextViewDelegate {
        var parent: PastableTextView

        init(_ parent: PastableTextView) {
            self.parent = parent
        }

        func updateHeight(for textView: UITextView) {
            let width = textView.bounds.width
            guard width > 0 else { return }
            let size = textView.sizeThatFits(CGSize(width: width, height: .infinity))
            let clamped = min(max(size.height, PastableTextView.minHeight), PastableTextView.maxHeight)
            textView.isScrollEnabled = size.height > PastableTextView.maxHeight
            if abs(parent.height - clamped) > 1 {
                parent.height = clamped
            }
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            if let pastable = textView as? PastableUITextView {
                pastable.placeholderLabel.isHidden = !textView.text.isEmpty
            }
            updateHeight(for: textView)
        }
    }
}

class PastableUITextView: UITextView {
    var onImagePaste: ((Data, String) -> Void)?
    weak var coordinator: PastableTextView.Coordinator?
    let placeholderLabel = UILabel()

    private var lastBoundsWidth: CGFloat = 0

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width != lastBoundsWidth {
            lastBoundsWidth = bounds.width
            coordinator?.updateHeight(for: self)
        }
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) {
            return UIPasteboard.general.hasImages || UIPasteboard.general.hasStrings
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        if UIPasteboard.general.hasImages,
           let image = UIPasteboard.general.image,
           let data = image.jpegData(compressionQuality: 0.8) {
            onImagePaste?(data, "image/jpeg")
            return
        }
        super.paste(sender)
    }
}
