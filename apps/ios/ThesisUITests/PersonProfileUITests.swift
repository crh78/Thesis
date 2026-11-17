import XCTest

/// Tapping a person anywhere opens their profile (mock data, -skipAuth).
final class PersonProfileUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-skipAuth"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 10))
    }

    /// The copy of an element that's actually on screen (feeds keep both pages loaded).
    private func onScreen(_ query: XCUIElementQuery) -> XCUIElement {
        query.allElementsBoundByIndex.first { $0.isHittable } ?? query.firstMatch
    }

    /// A person link: plain text, or a button whose label includes the name.
    private func link(_ name: String) -> XCUIElement {
        let text = app.staticTexts.matching(identifier: name)
        if text.allElementsBoundByIndex.contains(where: { $0.isHittable }) { return onScreen(text) }
        return onScreen(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR label CONTAINS %@", name, ", \(name)")))
    }

    private func assertProfile(_ handle: String, name: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(app.navigationBars[handle].waitForExistence(timeout: 5), "\(handle)'s profile opens", file: file, line: line)
        XCTAssertTrue(app.staticTexts["Takes"].exists, file: file, line: line)
        let follow = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Follow \(name)", "Unfollow \(name)"))
        XCTAssertTrue(onScreen(follow).exists, "Profile has a Follow button", file: file, line: line)
    }

    func testFeedAuthorOpensProfileWithTheirTakes() {
        onScreen(app.staticTexts.matching(identifier: "Jake")).tap()
        assertProfile("@jake", name: "Jake")
        XCTAssertTrue(app.staticTexts["AI power demand is underrated."].waitForExistence(timeout: 5), "Their takes are listed")
    }

    func testFollowFromProfileUpdatesButton() {
        onScreen(app.staticTexts.matching(identifier: "Dev")).tap()
        assertProfile("@dev", name: "Dev")
        let follow = onScreen(app.buttons.matching(identifier: "Follow Dev"))
        follow.tap()
        XCTAssertTrue(onScreen(app.buttons.matching(identifier: "Unfollow Dev")).waitForExistence(timeout: 3))
    }

    func testScoresRowOpensProfile() {
        app.tabBars.buttons["Scores"].tap()
        XCTAssertTrue(app.navigationBars["Scores"].waitForExistence(timeout: 5))
        link("@priya").tap()
        assertProfile("@priya", name: "Priya")
    }

    func testSearchTopCallerOpensProfile() {
        app.tabBars.buttons["Search"].tap()
        XCTAssertTrue(app.staticTexts["Top calls this week"].waitForExistence(timeout: 5))
        onScreen(app.staticTexts.matching(identifier: "lena")).tap()
        assertProfile("@lena", name: "Lena")
    }

    func testCommenterOpensProfile() {
        onScreen(app.staticTexts.matching(identifier: "AI power demand is underrated.")).tap()
        XCTAssertTrue(app.staticTexts["Basket"].waitForExistence(timeout: 5))
        app.swipeUp()
        app.buttons["See all"].tap()
        XCTAssertTrue(app.navigationBars["Comments · 12"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Mo"].firstMatch.waitForExistence(timeout: 5) || link("Mo").exists)
        link("Mo").tap()
        assertProfile("@mo", name: "Mo")
    }

    func testTakePageNamesTradersAndOpensThem() {
        onScreen(app.staticTexts.matching(identifier: "AI power demand is underrated.")).tap()
        XCTAssertTrue(app.staticTexts["Basket"].waitForExistence(timeout: 5))
        let line = app.buttons["traders-line"]
        // Scroll it clear of the Fade / Trade bar (it can sit just under it and still count as hittable).
        let barTop = app.frame.maxY - 140
        for _ in 0..<4 where !line.isHittable || line.frame.maxY > barTop { app.swipeUp() }
        XCTAssertTrue(line.label.contains("You, Priya and 22 others traded"), "Names real traders: \(line.label)")
        line.tap()
        XCTAssertTrue(app.navigationBars["Traders"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Faded · 7"].exists)
        link("Priya").tap()
        assertProfile("@priya", name: "Priya")
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Faded · 7"].tap()
        XCTAssertTrue(link("Dev").waitForExistence(timeout: 3), "Faded tab lists faders")
    }
}
