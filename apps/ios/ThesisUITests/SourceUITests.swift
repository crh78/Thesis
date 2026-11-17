import XCTest

/// Takes from what you read (the share sheet) and copying X accounts, offline with mock data.
/// The live halves (reading a real article, Apify) are covered by supabase/functions/source tests
/// and the dogfood checks in docs.
final class SourceUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-skipAuth"]
        app.launch()
    }

    /// What the share extension hands the app: read the page, then the composer, filled in and
    /// credited to the site.
    func testSharedArticleOpensTheComposerOnADraftedTake() {
        XCTAssertTrue(app.tabBars.buttons["Me"].waitForExistence(timeout: 10))
        app.open(URL(string: "yourthesis-dev://take/new?read=https%3A%2F%2Fwww.cnbc.com%2F2026%2F11%2F13%2Fgold.html&title=Gold%20hits%20a%20record%20high")!)
        // Reading is brief offline (no article to fetch), so assert where it lands.
        let credit = app.staticTexts["via cnbc.com"]
        let landed = credit.waitForExistence(timeout: 15)
        if !landed { print("TREE>>>", app.debugDescription) }
        XCTAssertTrue(landed, "The composer credits the site")
        XCTAssertTrue(app.textViews.firstMatch.value as? String == "Gold hits a record high", "The drafted take is filled in")
        XCTAssertTrue(app.buttons["Build my basket"].isEnabled)
    }

    /// Copying an X call: straight to the basket, credited to the post.
    func testCopiedCallLandsOnTheBasketCredited() {
        app.open(URL(string: "yourthesis-dev://take/new?claim=Bitcoin%27s%20selloff%20has%20further%20to%20run&risk=high&horizon=1%20month&source_url=https%3A%2F%2Fx.com%2FKobeissiLetter%2Fstatus%2F1&source_label=%40KobeissiLetter%20on%20X")!)
        XCTAssertTrue(app.navigationBars["Your basket"].waitForExistence(timeout: 20), "Builds and lands on the basket")
        XCTAssertTrue(app.staticTexts["via @KobeissiLetter on X"].exists, "Credited to the post")
    }

    /// Me → Copy traders from X → an account's call → its basket.
    func testCopyFromXListsCallsAndCopiesOne() {
        app.tabBars.buttons["Search"].tap()
        let open = app.buttons["open-x-copy"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.tap()
        XCTAssertTrue(app.navigationBars["Copy from X"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["The Kobeissi Letter"].waitForExistence(timeout: 5), "Lists the accounts you copy")
        let copy = app.buttons.matching(identifier: "x-call-copy").firstMatch
        XCTAssertTrue(copy.exists, "Each call has Copy")
        copy.tap()
        XCTAssertTrue(app.navigationBars["Your basket"].waitForExistence(timeout: 20), "Copying builds the basket")
        XCTAssertTrue(app.staticTexts["via @KobeissiLetter on X"].exists)
    }

    /// Adding an account by handle (offline: it appears at the top).
    func testCopyAnAccountByHandle() {
        app.tabBars.buttons["Search"].tap()
        app.buttons["open-x-copy"].tap()
        let add = app.buttons["x-add"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.tap()
        let field = app.textFields["x-handle"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("@unusual_whales")
        app.buttons["x-copy-button"].tap()
        XCTAssertTrue(app.buttons["@unusual_whales"].waitForExistence(timeout: 5), "The new account joins the row")
    }
}
