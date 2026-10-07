import XCTest

final class TextFieldWrappingTest: XCTestCase {
    let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = true
        app.launchArguments = ["-serverURL", "http://localhost:3000"]
        app.launch()
    }

    func testTextFieldWrapsVerticallyAndScrollsAfterFiveLines() throws {
        // Navigate to first chat session
        let firstCell = app.cells.firstMatch
        XCTAssertTrue(firstCell.waitForExistence(timeout: 10), "No chat sessions found")
        firstCell.tap()

        // Find the text input field
        let textView = app.textViews.firstMatch
        XCTAssertTrue(textView.waitForExistence(timeout: 5), "No text field found in chat view")

        let screenWidth = app.frame.width
        let initialFrame = textView.frame
        print("INITIAL: \(initialFrame)")

        // Type enough text to wrap to 2-3 lines
        textView.tap()
        textView.typeText("This is a message that should wrap to multiple lines in the text field")
        sleep(1) // let layout settle

        let afterWrapFrame = textView.frame
        print("AFTER WRAP: \(afterWrapFrame)")

        // Width must stay the same
        XCTAssertEqual(afterWrapFrame.width, initialFrame.width, accuracy: 2.0,
            "Width grew: \(initialFrame.width) -> \(afterWrapFrame.width)")

        // Height must grow
        XCTAssertGreaterThan(afterWrapFrame.height, initialFrame.height,
            "Height did NOT grow: \(initialFrame.height) -> \(afterWrapFrame.height)")

        // Type more for 5+ lines
        textView.typeText(". Adding more and more text to fill more lines. And more text here. And even more text to make sure we exceed five lines.")
        sleep(1)

        let afterManyLines = textView.frame
        print("AFTER MANY LINES: \(afterManyLines)")

        // Height should cap at maxHeight (~120pt)
        XCTAssertLessThanOrEqual(afterManyLines.height, 130,
            "Height should cap at ~120pt, got \(afterManyLines.height)")

        // Force-report all values for debugging
        print("SUMMARY: screen=\(screenWidth) initial=\(initialFrame) wrap=\(afterWrapFrame) many=\(afterManyLines)")
    }
}
