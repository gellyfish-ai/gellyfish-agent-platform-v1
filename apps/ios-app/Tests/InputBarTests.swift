import XCTest

final class InputBarTests: XCTestCase {
    let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchArguments = ["-serverURL", "http://localhost:3000"]
        app.launch()
    }

    private func navigateToChat() throws -> XCUIElement {
        let firstCell = app.cells.firstMatch
        XCTAssertTrue(firstCell.waitForExistence(timeout: 10), "No chat sessions loaded")
        firstCell.tap()
        let textView = app.textViews.firstMatch
        XCTAssertTrue(textView.waitForExistence(timeout: 5), "Text input not found in chat")
        return textView
    }

    // MARK: - Text Wrapping

    func testTextFieldDoesNotGrowHorizontally() throws {
        let textView = try navigateToChat()
        let initialWidth = textView.frame.width

        textView.tap()
        textView.typeText("This is a long message that should wrap to the next line instead of growing wider")
        sleep(1)

        XCTAssertEqual(textView.frame.width, initialWidth, accuracy: 2.0,
            "Text field grew horizontally: \(initialWidth) -> \(textView.frame.width)")
    }

    func testTextFieldGrowsVerticallyOnWrap() throws {
        let textView = try navigateToChat()
        let initialHeight = textView.frame.height

        textView.tap()
        textView.typeText("Line one of text that wraps. And more text to ensure wrapping happens properly.")
        sleep(1)

        XCTAssertGreaterThan(textView.frame.height, initialHeight,
            "Text field should grow vertically: stayed at \(textView.frame.height)")
    }

    func testTextFieldCapsHeightAndScrolls() throws {
        let textView = try navigateToChat()

        textView.tap()
        textView.typeText("Line 1. Line 2 with more text. Line 3 even more. Line 4 still going. Line 5 and beyond. Line 6 definitely past the limit now. Line 7 for good measure.")
        sleep(1)

        // maxHeight is 120pt
        XCTAssertLessThanOrEqual(textView.frame.height, 130,
            "Text field should cap at ~120pt, got \(textView.frame.height)")
        XCTAssertGreaterThan(textView.frame.height, 100,
            "Text field should be near max height with this much text, got \(textView.frame.height)")
    }

    func testTextFieldResetsHeightAfterSend() throws {
        let textView = try navigateToChat()
        let initialHeight = textView.frame.height

        textView.tap()
        textView.typeText("Multi line text that should make the field grow taller than one line for sure")
        sleep(1)

        // Tap send button
        let sendButton = app.buttons["arrow.up.circle.fill"]
        if sendButton.exists && sendButton.isEnabled {
            sendButton.tap()
            sleep(1)
            XCTAssertEqual(textView.frame.height, initialHeight, accuracy: 5.0,
                "Text field should reset to initial height after send: \(textView.frame.height) vs \(initialHeight)")
        }
    }

    // MARK: - Input Bar Layout

    func testInputBarElementsExist() throws {
        _ = try navigateToChat()

        // Paperclip (photo picker)
        XCTAssertTrue(app.buttons["paperclip"].exists, "Photo picker button missing")

        // Voice mode
        XCTAssertTrue(app.buttons["waveform"].exists, "Voice mode button missing")

        // Send button
        XCTAssertTrue(app.buttons["arrow.up.circle.fill"].exists, "Send button missing")

        // Text field
        XCTAssertTrue(app.textViews.firstMatch.exists, "Text input missing")
    }

    func testSendButtonDisabledWhenEmpty() throws {
        _ = try navigateToChat()

        let sendButton = app.buttons["arrow.up.circle.fill"]
        XCTAssertTrue(sendButton.exists, "Send button not found")
        XCTAssertFalse(sendButton.isEnabled, "Send button should be disabled when text is empty")
    }

    func testSendButtonEnabledWithText() throws {
        let textView = try navigateToChat()

        textView.tap()
        textView.typeText("Hello")

        let sendButton = app.buttons["arrow.up.circle.fill"]
        XCTAssertTrue(sendButton.isEnabled, "Send button should be enabled when text is entered")
    }
}
