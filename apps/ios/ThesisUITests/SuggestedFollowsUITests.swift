import XCTest

/// "Suggested for you" on mock data (-skipAuth).
final class SuggestedFollowsUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-skipAuth"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 10))
    }

    func testSearchSuggestsPeopleToFollowAndDismiss() {
        app.tabBars.buttons["Search"].tap()
        XCTAssertTrue(app.staticTexts["Suggested for you"].waitForExistence(timeout: 5))
        app.buttons["Follow Kai"].tap()
        XCTAssertTrue(app.buttons["Unfollow Kai"].waitForExistence(timeout: 3), "Follow from a suggestion")
        app.buttons["Dismiss Dev"].tap()
        XCTAssertTrue(app.buttons["Dismiss Dev"].waitForNonExistence(timeout: 3), "Dismiss hides the suggestion")
    }

    func testFollowingFeedShowsSuggestions() {
        app.buttons["Following"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Suggested for you"].waitForExistence(timeout: 5))
    }
}
