import XCTest

/// The trade sheet's Buy | Sell tabs and the profile's swipe-to-sell, on mock data (offline).
/// Mock: $20 of AI power demand bought at $1.00, worth $22.80 at $1.14; balance $182.40. A partial
/// sale has to leave at least $10 in, so at most 50% ($11.40) of it sells short of all of it.
final class PartialSalesUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-skipAuth"]
        app.launch()
        XCTAssertTrue(app.staticTexts["thesis"].waitForExistence(timeout: 10), "Feed should load")
    }

    private func button(startingWith prefix: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func element(containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private var tabs: XCUIElement { app.segmentedControls["trade-tabs"] }

    /// Feed → Trade on Jake's AI power take (which you hold): the sheet opens on Buy.
    private func openTradeSheet() {
        let trade = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Trade"))
        (trade.allElementsBoundByIndex.first { $0.isHittable } ?? trade.firstMatch).tap()
        XCTAssertTrue(app.staticTexts["Trade Jake's take"].waitForExistence(timeout: 5))
    }

    func testTradeSheetOpensOnBuyAndSwitchesToSell() {
        openTradeSheet()
        XCTAssertTrue(tabs.exists, "Buy | Sell tabs")
        XCTAssertTrue(tabs.buttons["Buy"].isSelected, "Buy opens first")
        XCTAssertTrue(button(startingWith: "Trade for $20").exists)

        tabs.buttons["Sell"].tap()
        XCTAssertTrue(app.staticTexts["Sell your trade"].waitForExistence(timeout: 3))
        XCTAssertTrue(button(startingWith: "Sell all for $22.80").exists, "Sell starts at all of it")

        tabs.buttons["Buy"].tap()
        XCTAssertTrue(button(startingWith: "Trade for $20").waitForExistence(timeout: 3), "Back on Buy")
    }

    func testSellTabDisablesPartsThatLeaveLessThanTheMinimum() {
        openTradeSheet()
        tabs.buttons["Sell"].tap()
        XCTAssertTrue(app.staticTexts["Sell your trade"].waitForExistence(timeout: 3))

        // 75% would leave $5 in: off, and it says why. 50% leaves $10: fine.
        XCTAssertFalse(app.buttons["75%"].isEnabled, "75% would leave less than $10")
        XCTAssertTrue(app.buttons["25%"].isEnabled)
        XCTAssertTrue(app.buttons["50%"].isEnabled)
        XCTAssertTrue(app.buttons["All"].isEnabled, "All always works")
        XCTAssertTrue(element(containing: "Up to 50% ($11.40)").exists, "Says how much and why")
        XCTAssertTrue(element(containing: "keeps at least $10").exists)

        app.buttons["25%"].tap()
        XCTAssertTrue(button(startingWith: "Sell $5.70").waitForExistence(timeout: 3))
        XCTAssertTrue(element(containing: "keeps $15.00 in").exists, "The part that stays")
    }

    func testSellTabInDollars() {
        openTradeSheet()
        tabs.buttons["Sell"].tap()
        XCTAssertTrue(app.staticTexts["Sell your trade"].waitForExistence(timeout: 3))

        app.segmentedControls["sell-mode"].buttons["$"].tap()
        XCTAssertTrue(app.buttons["$10"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["$10"].isEnabled)
        XCTAssertFalse(app.buttons["$25"].isEnabled, "More than it's worth: that's All")
        app.buttons["$10"].tap()
        XCTAssertTrue(button(startingWith: "Sell $10.00").waitForExistence(timeout: 3))

        // A typed $15 would leave less than $10 in: refused, with the most it can sell.
        let field = app.textFields["sell-amount"]
        field.tap()
        let current = (field.value as? String) ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2) + "15")
        let capped = button(startingWith: "Sell up to 50%")
        XCTAssertTrue(capped.waitForExistence(timeout: 3))
        XCTAssertFalse(capped.isEnabled)
        XCTAssertTrue(element(containing: "A position has to keep at least $10").exists)
    }

    func testSellingHalfFromTheSellTab() {
        openTradeSheet()
        tabs.buttons["Sell"].tap()
        app.buttons["50%"].tap()
        let sell = button(startingWith: "Sell $11.40")
        XCTAssertTrue(sell.waitForExistence(timeout: 3))
        sell.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.staticTexts["Sell your trade"])
        waitForExpectations(timeout: 5)
        XCTAssertTrue(app.buttons["Balance $193.80. Add cash"].waitForExistence(timeout: 5), "$182.40 + $11.40")
    }

    // MARK: Profile

    private func aiPowerRow() -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "AI power demand")).firstMatch
    }

    private var question: XCUIElement {
        app.alerts.matching(NSPredicate(format: "label CONTAINS %@", "Sell all of your $22.80 position in “AI power demand is underrated”?")).firstMatch
    }

    func testSwipeLeftOnAPositionSellsAllAfterConfirming() {
        app.tabBars.buttons["Me"].firstMatch.tap()
        let row = aiPowerRow()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.swipeLeft()
        XCTAssertTrue(question.waitForExistence(timeout: 3), "Asks first")
        question.buttons["Sell all"].tap()
        XCTAssertFalse(app.staticTexts["Your position"].waitForExistence(timeout: 2), "The swipe didn't also open the take")
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: aiPowerRow())
        waitForExpectations(timeout: 5)
        XCTAssertTrue(element(containing: "$205.20").waitForExistence(timeout: 5), "$182.40 + $22.80")
    }

    func testRedArrowAsksAndCancelKeepsThePosition() {
        app.tabBars.buttons["Me"].firstMatch.tap()
        XCTAssertTrue(aiPowerRow().waitForExistence(timeout: 5))
        app.buttons.matching(identifier: "position.sell").firstMatch.tap()
        XCTAssertTrue(question.waitForExistence(timeout: 3), "The red arrow asks too")
        question.buttons["Cancel"].tap()
        XCTAssertTrue(aiPowerRow().exists, "Nothing sold")
        XCTAssertTrue(element(containing: "$182.40").exists, "Balance unchanged")
    }
}
