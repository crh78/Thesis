import XCTest

/// Assets and basket editing (mock data, -skipAuth): searching assets and people, asset pages,
/// a take's picks opening their asset, and changing a basket by asking or by hand.
final class AssetsUITests: XCTestCase {
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

    private func searchFor(_ text: String, in scope: String) {
        app.tabBars.buttons["Search"].tap()
        XCTAssertTrue(app.navigationBars["Search"].waitForExistence(timeout: 5))
        app.segmentedControls["search-scope"].buttons[scope].tap()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 8), app.debugDescription)
        field.tap()
        field.typeText(text)
    }

    /// The AI-power basket from a take link (offline the build is instant).
    private func openBasket() {
        app.open(URL(string: "yourthesis-dev://take/new?claim=AI%20power%20demand%20is%20underrated&risk=medium&horizon=3%20months")!)
        XCTAssertTrue(app.navigationBars["Your basket"].waitForExistence(timeout: 20), "Basket")
    }

    private func pick(_ name: String) -> XCUIElement {
        app.staticTexts.matching(identifier: name).firstMatch
    }

    func testSearchAssetsOpensItsPage() {
        searchFor("micron", in: "Assets")
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Micron Technology'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Micron shows up")
        row.tap()
        XCTAssertTrue(app.staticTexts["asset-name"].waitForExistence(timeout: 5), "Asset page opens")
        XCTAssertEqual(app.staticTexts["asset-name"].label, "Micron Technology")
        XCTAssertTrue(app.staticTexts["asset-price"].exists, "Shows its price")
        XCTAssertTrue(app.staticTexts["What it is"].exists)
        XCTAssertTrue(app.buttons["asset-make-take"].exists, "Offers to make a take with it")
    }

    func testSearchPeople() {
        searchFor("pri", in: "People")
        XCTAssertTrue(app.staticTexts["Priya"].waitForExistence(timeout: 5), "Finds Priya")
    }

    func testTakePickOpensItsAsset() {
        onScreen(app.staticTexts.matching(identifier: "AI power demand is underrated.")).tap()
        let vistra = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Vistra'")).firstMatch
        XCTAssertTrue(vistra.waitForExistence(timeout: 5), "The pick is tappable")
        vistra.tap()
        XCTAssertTrue(app.staticTexts["asset-name"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["asset-name"].label, "Vistra")
        XCTAssertTrue(app.staticTexts["Takes with Vistra"].waitForExistence(timeout: 5), "Lists takes that hold it")
    }

    func testMakeATakeFromAnAsset() {
        searchFor("bloom", in: "Assets")
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Bloom Energy'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        let make = app.buttons["asset-make-take"]
        XCTAssertTrue(make.waitForExistence(timeout: 5))
        make.tap()
        XCTAssertTrue(app.navigationBars["New take"].waitForExistence(timeout: 5), "Composer opens")
        XCTAssertTrue(app.staticTexts["Your basket starts with Bloom Energy"].exists, "With the asset pinned")

        app.textViews.firstMatch.tap()
        app.textViews.firstMatch.typeText("Data centers will run on their own power.")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Build my basket'")).firstMatch.tap()
        let see = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'See your basket'")).firstMatch
        XCTAssertTrue(see.waitForExistence(timeout: 10))
        see.tap()
        XCTAssertTrue(pick("Bloom Energy").waitForExistence(timeout: 5), "The basket keeps the asset you started from")
    }

    func testAddAPickBySearching() {
        openBasket()
        app.buttons["basket-add-pick"].tap()
        XCTAssertTrue(app.navigationBars["Add a pick"].waitForExistence(timeout: 5))
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("amd")
        let amd = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Advanced Micro Devices'")).firstMatch
        XCTAssertTrue(amd.waitForExistence(timeout: 5))
        amd.tap()
        XCTAssertTrue(pick("Advanced Micro Devices").waitForExistence(timeout: 5), "AMD is in the basket")
        XCTAssertTrue(app.staticTexts["20%"].exists, "Five picks at an even share for the new one")
    }

    func testAskToChangeTheBasket() {
        openBasket()
        let field = app.textFields["basket-change-field"]
        field.tap()
        field.typeText("add Micron")
        app.buttons["basket-change-send"].tap()
        XCTAssertTrue(pick("Micron Technology").waitForExistence(timeout: 5), "Micron added")

        field.tap()
        field.typeText("add Unobtainium\n") // return sends it too
        let note = app.staticTexts["basket-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        XCTAssertTrue(note.label.hasPrefix("Couldn't find"), "Says when it can't make the change")
    }

    func testRemoveAndReweightAPick() {
        openBasket()
        app.buttons["More for Vistra"].tap()
        app.buttons["Remove"].tap()
        XCTAssertTrue(pick("Vistra").waitForNonExistence(timeout: 3), "Vistra is gone")

        app.buttons["More for Constellation"].tap()
        app.buttons["Set weight"].tap()
        let slider = app.sliders["weight-slider"]
        XCTAssertTrue(slider.waitForExistence(timeout: 5))
        slider.adjust(toNormalizedSliderPosition: 0.6)
        let value = app.staticTexts["weight-value"].label
        app.buttons["weight-done"].tap()
        XCTAssertTrue(app.staticTexts[value].waitForExistence(timeout: 3), "Constellation is at the weight you set (\(value))")
    }

    func testRiskChangeKeepsYourPicks() {
        openBasket()
        app.buttons["More for Vistra"].tap()
        app.buttons["Remove"].tap()
        XCTAssertTrue(pick("Vistra").waitForNonExistence(timeout: 3))

        app.segmentedControls.buttons["Low risk"].tap()
        XCTAssertTrue(pick("Cash").waitForExistence(timeout: 5), "Low risk adds cash")
        XCTAssertFalse(pick("Vistra").exists, "The pick you removed stays out")
        XCTAssertTrue(pick("Constellation").exists, "Your other picks stay")
    }
}
