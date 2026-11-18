import XCTest

/// The take typed in the "Your take" bar must carry through the create flow.
final class CreateFlowUITests: XCTestCase {
    func testTypedTakeShowsOnTheBuildingCard() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-skipAuth"]
        app.launch()

        app.buttons["Your take"].tap()
        let field = app.textFields["Your take"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("Copper squeezes into year end.")
        app.buttons["composer-start"].tap()
        XCTAssertTrue(app.navigationBars["New take"].waitForExistence(timeout: 5))
        // No horizon to pick: the composer asks only for risk, and says how long a take runs.
        XCTAssertFalse(app.staticTexts["How long should it run?"].exists, "No horizon step")
        XCTAssertEqual(app.staticTexts["take-lifetime"].label, "Your take runs until you sell your buy-in, or a year at most.")

        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Build my basket'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Medium risk"].waitForExistence(timeout: 5), "Building card is up")
        let onCard = app.staticTexts.matching(identifier: "Copper squeezes into year end.")
            .allElementsBoundByIndex.contains { $0.isHittable }
        XCTAssertTrue(onCard, "The border-beam card should show the typed take, not a blank line")
    }

    /// A take link from chat (the iMessage agent's link, after the open redirect)
    /// skips the composer: building with its risk, then the basket. Older links still carry a
    /// horizon; it's ignored.
    func testTakeLinkOpensStraightToTheBasket() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-skipAuth"]
        app.launch()

        app.open(URL(string: "yourthesis-dev://take/new?claim=Gold%20goes%20up%20as%20the%20dollar%20weakens&risk=low&horizon=1%20month")!)
        // Building is brief offline (mock basket), so assert where it lands.
        XCTAssertTrue(app.navigationBars["Your basket"].waitForExistence(timeout: 20), "Builds and lands on the basket by itself")
        XCTAssertTrue(app.buttons["Low risk"].isSelected, "The link's risk carried through")
        XCTAssertEqual(app.staticTexts["take-lifetime"].label, "Your take runs until you sell your buy-in, or a year at most.",
                       "Runs until the author sells, not to a horizon")
    }
}
