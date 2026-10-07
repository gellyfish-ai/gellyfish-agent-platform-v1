import SwiftUI

struct EmojiPickerView: View {
    let onSelect: (String) -> Void

    // Same emoji list as web UI (reactions.js)
    private let emojis = ["👍","👎","😂","🤔","❌","🎉","🔥","✅","❤️","😮","😢","🙏","👀","💯","⚡","🚀","🤦","🫡","👏","😬","🤷","💀","🫠","😍","🥳","🤝","☠️","💡","⭐","🐛"]

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 6)

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(emojis, id: \.self) { emoji in
                        Button {
                            onSelect(emoji)
                        } label: {
                            Text(emoji)
                                .font(.system(size: 32))
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("React")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onSelect("") }
                }
            }
        }
    }
}
