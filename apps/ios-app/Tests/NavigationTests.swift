import XCTest

final class NavigationTests: XCTestCase {
    let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchArguments = ["-serverURL", "http://localhost:3000"]
        app.launch()
    }

    // MARK: - Tab Bar

    func testTabBarExists() throws {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 5), "Tab bar not found")
    }

    func testAllTabsExist() throws {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 5))

        XCTAssertTrue(tabBar.buttons["Crews"].exists, "Crews tab missing")
        XCTAssertTrue(tabBar.buttons["Profiles"].exists, "Profiles tab missing")
        XCTAssertTrue(tabBar.buttons["Chats"].exists, "Chats tab missing")
        XCTAssertTrue(tabBar.buttons["More"].exists, "More tab missing")
    }

    func testChatsTabIsDefault() throws {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 5))
        XCTAssertTrue(tabBar.buttons["Chats"].isSelected, "Chats should be the default tab")
    }

    func testNavigateToCrewsTab() throws {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 5))
        tabBar.buttons["Crews"].tap()
        // Should show crews list
        XCTAssertTrue(app.navigationBars["Crews"].waitForExistence(timeout: 5) ||
                      app.staticTexts["Crews"].waitForExistence(timeout: 5),
                      "Crews view not shown")
    }

    func testNavigateToProfilesTab() throws {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 5))
        tabBar.buttons["Profiles"].tap()
        XCTAssertTrue(app.navigationBars["Profiles"].waitForExistence(timeout: 5) ||
                      app.staticTexts["Profiles"].waitForExistence(timeout: 5),
                      "Profiles view not shown")
    }

    func testNavigateToMoreTab() throws {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 5))
        tabBar.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5) ||
                      app.staticTexts["Settings"].waitForExistence(timeout: 5) ||
                      app.staticTexts["More"].waitForExistence(timeout: 5),
                      "More/Settings view not shown")
    }

    // MARK: - Chat Navigation

    func testTapChatSessionOpensChat() throws {
        let firstCell = app.cells.firstMatch
        XCTAssertTrue(firstCell.waitForExistence(timeout: 10), "No sessions in list")
        firstCell.tap()

        // Should show chat view with text input and toolbar
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 5),
                      "Chat view text input not found after tapping session")
    }

    func testChatViewHasRefreshButton() throws {
        let firstCell = app.cells.firstMatch
        XCTAssertTrue(firstCell.waitForExistence(timeout: 10))
        firstCell.tap()

        XCTAssertTrue(app.buttons["arrow.clockwise"].waitForExistence(timeout: 5),
                      "Refresh button missing in chat toolbar")
    }

    func testChatViewHasInfoButton() throws {
        let firstCell = app.cells.firstMatch
        XCTAssertTrue(firstCell.waitForExistence(timeout: 10))
        firstCell.tap()

        XCTAssertTrue(app.buttons["info.circle"].waitForExistence(timeout: 5),
                      "Info button missing in chat toolbar")
    }

    func testBackNavigationFromChat() throws {
        let firstCell = app.cells.firstMatch
        XCTAssertTrue(firstCell.waitForExistence(timeout: 10))
        firstCell.tap()

        // Wait for chat to load
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 5))

        // Navigate back
        app.navigationBars.buttons.firstMatch.tap()

        // Should be back on session list
        XCTAssertTrue(app.cells.firstMatch.waitForExistence(timeout: 5),
                      "Session list not visible after back navigation")
    }
}
