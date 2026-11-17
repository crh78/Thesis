import XCTest

/// Follow lists and privacy (mock data, -skipAuth): anyone's lists from their
/// profile, Settings → Privacy, removing a follower.
final class FollowPrivacyUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-skipAuth"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 10))
    }

    private func onScreen(_ query: XCUIElementQuery) -> XCUIElement {
        query.allElementsBoundByIndex.first { $0.isHittable } ?? query.firstMatch
    }

    private func button(startingWith prefix: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func openSettingsFromSidebar() {
        app.buttons["Open profile menu"].tap()
        let settings = app.buttons["settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5), "Settings opens")
    }

    func testSettingsHasPrivacyAndAccount() {
        openSettingsFromSidebar()
        XCTAssertTrue(app.switches["settings-show-following"].exists)
        XCTAssertTrue(app.switches["settings-show-followers"].exists)
        XCTAssertTrue(app.buttons["settings-delete-account"].exists, "Delete account is offered")
    }

    func testHidingFollowingMarksYourListPrivate() {
        openSettingsFromSidebar()
        let toggle = app.switches["settings-show-following"]
        XCTAssertEqual(toggle.value as? String, "1")
        toggle.switches.firstMatch.tap()
        XCTAssertEqual(toggle.value as? String, "0", "Show who you follow is off")

        app.navigationBars["Settings"].buttons.firstMatch.tap() // back to Home
        app.buttons["Open profile menu"].tap()
        let count = app.buttons.matching(NSPredicate(format: "label ENDSWITH ' Following'")).firstMatch
        XCTAssertTrue(count.waitForExistence(timeout: 5))
        count.tap()
        XCTAssertTrue(app.buttons["Only you can see this list"].waitForExistence(timeout: 5)
                      || app.staticTexts["Only you can see this list"].waitForExistence(timeout: 2),
                      "Your hidden list says only you can see it")
    }

    func testRemoveAFollower() {
        app.buttons["Open profile menu"].tap()
        button(startingWith: "342 Followers").tap()
        // The sidebar is still closing as Followers slides in: wait for the list first.
        XCTAssertTrue(app.staticTexts["Professional fader. Nothing personal."].waitForExistence(timeout: 10), "Followers list")
        let more = app.buttons["More for Mo"]
        XCTAssertTrue(more.waitForExistence(timeout: 10), "Your followers have a menu")
        more.tap()
        app.buttons["Remove this follower"].tap()
        let remove = app.buttons["Remove"]
        XCTAssertTrue(remove.waitForExistence(timeout: 3), "Asks first")
        remove.tap()
        XCTAssertTrue(more.waitForNonExistence(timeout: 3), "Mo is gone from your followers")
    }

    func testSomeonesFollowingOpensFromTheirProfile() {
        onScreen(app.staticTexts.matching(identifier: "Jake")).tap()
        XCTAssertTrue(app.navigationBars["@jake"].waitForExistence(timeout: 5))
        let following = app.buttons["person-following"]
        XCTAssertTrue(following.waitForExistence(timeout: 5))
        following.tap()
        XCTAssertTrue(app.navigationBars["Jake"].waitForExistence(timeout: 5), "Jake's lists open")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Follow ' OR label BEGINSWITH 'Unfollow '")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Shows the people Jake follows")
        XCTAssertFalse(app.buttons["Only you can see this list"].exists, "That note is only for your own lists")
    }

    func testMeTabGearOpensSettings() {
        app.tabBars.buttons["Me"].tap()
        app.buttons["Settings"].tap()
        let item = app.buttons["Settings"].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 3))
        app.collectionViews.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5), "Settings opens from Me")
    }
}
