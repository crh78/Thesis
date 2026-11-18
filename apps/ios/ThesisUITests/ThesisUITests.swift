import XCTest

/// Smoke tests that tap through the main flows on mock data.
final class ThesisUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-skipAuth"] // mock-data flows; sign-in is covered by OnboardingUITests
        app.launch()
        XCTAssertTrue(app.staticTexts["thesis"].waitForExistence(timeout: 10), "Feed should load")
    }

    private func button(startingWith prefix: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    /// Both feed pages stay loaded side by side, so the same take can exist
    /// twice; pick the copy that's actually on screen.
    private func onScreen(_ query: XCUIElementQuery) -> XCUIElement {
        query.allElementsBoundByIndex.first { $0.isHittable } ?? query.firstMatch
    }

    func testTabsSwitch() {
        app.tabBars.buttons["Scores"].tap()
        XCTAssertTrue(app.navigationBars["Scores"].waitForExistence(timeout: 5))
        app.buttons["Return %"].tap()
        XCTAssertTrue(app.staticTexts["@kai"].waitForExistence(timeout: 3), "Return ranking should put @kai on the board")

        app.tabBars.buttons["Me"].tap()
        XCTAssertTrue(app.staticTexts["Sarah"].waitForExistence(timeout: 5))
        app.buttons["My takes"].tap()
        XCTAssertTrue(app.staticTexts["Copper squeeze is coming."].waitForExistence(timeout: 3))

        app.tabBars.buttons["Search"].tap()
        XCTAssertTrue(app.navigationBars["Search"].waitForExistence(timeout: 5))
        app.buttons["Housing"].tap()
        XCTAssertTrue(app.staticTexts["Mortgage rates dip under 6% by spring."].waitForExistence(timeout: 3))
    }

    func testBackSheetFromFeed() {
        onScreen(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Trade"))).tap()
        XCTAssertTrue(app.staticTexts["Trade Jake's take"].waitForExistence(timeout: 5))
        XCTAssertTrue(button(startingWith: "Trade for $20").exists, "Starts at $20")
        app.buttons["$50"].tap()
        XCTAssertTrue(button(startingWith: "Trade for $50").waitForExistence(timeout: 3), "CTA should follow the chosen amount")
        app.buttons["Close"].tap()
        XCTAssertTrue(app.staticTexts["thesis"].waitForExistence(timeout: 5))
    }

    func testTradingTakesTheAmountFromYourBalance() {
        onScreen(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Trade"))).tap()
        XCTAssertTrue(app.staticTexts["Trade Jake's take"].waitForExistence(timeout: 5))
        app.buttons["$50"].tap()
        button(startingWith: "Trade for $50").tap()
        XCTAssertTrue(app.buttons["Balance $132.40. Add cash"].waitForExistence(timeout: 5), "$182.40 − $50")
        app.buttons["Open profile menu"].tap()
        button(startingWith: "Cash activity").tap()
        XCTAssertTrue(app.staticTexts["Traded"].waitForExistence(timeout: 5), "The trade shows in activity")
    }

    func testTradeShowsYoureInThenCloses() {
        onScreen(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Trade"))).tap()
        XCTAssertTrue(app.staticTexts["Trade Jake's take"].waitForExistence(timeout: 5))
        button(startingWith: "Trade for $20").tap()
        XCTAssertTrue(app.buttons["trade-youre-in"].waitForExistence(timeout: 3), "The sheet says the trade is placed")
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.staticTexts["Trade Jake's take"])
        waitForExpectations(timeout: 5)
    }

    /// A trade the fork accepts but that doesn't land (`-mockTradeFails`): the sheet says so, offers
    /// Try again, and the balance comes back.
    func testTradeThatDoesntLandRollsBack() {
        app.terminate()
        app.launchArguments += ["-mockTradeFails"]
        app.launch()
        XCTAssertTrue(app.staticTexts["thesis"].waitForExistence(timeout: 10), "Feed should load")
        onScreen(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Trade"))).tap()
        XCTAssertTrue(app.staticTexts["Trade Jake's take"].waitForExistence(timeout: 5))
        app.buttons["$50"].tap()
        button(startingWith: "Trade for $50").tap()
        XCTAssertTrue(app.buttons["trade-youre-in"].waitForExistence(timeout: 3), "Placed as soon as it's accepted")
        XCTAssertTrue(element(containing: "That trade didn't go through. Nothing left your balance.").waitForExistence(timeout: 5))
        XCTAssertTrue(button(startingWith: "Try again").exists, "Offers another try")
        XCTAssertTrue(element(containing: "$132.40 left").exists, "The $50 is back: $182.40 − $50 left after another try")
        app.buttons["Close"].tap()
        XCTAssertTrue(app.buttons["Balance $182.40. Add cash"].waitForExistence(timeout: 5), "Nothing left the balance")
    }

    func testTradeAmountOverBalanceOffersAddCash() {
        onScreen(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Trade"))).tap()
        XCTAssertTrue(app.staticTexts["Trade Jake's take"].waitForExistence(timeout: 5))
        let field = app.textFields["trade-amount"]
        field.tap()
        let current = (field.value as? String) ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2) + "500")
        XCTAssertTrue(button(startingWith: "Add cash to trade $500").waitForExistence(timeout: 3),
                      "More than the $182.40 balance offers Add cash")
    }

    /// Me → a position → its take page → Sell. Mock: $20 of AI power bought at
    /// $1.00, worth $22.80 at $1.14; balance $182.40.
    private func openSellSheet() {
        app.tabBars.buttons["Me"].firstMatch.tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "AI power demand")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Your position"].waitForExistence(timeout: 5))
        app.swipeUp()
        app.buttons["sell-trade"].tap()
        XCTAssertTrue(app.staticTexts["Sell your trade"].waitForExistence(timeout: 5))
    }

    func testSellingPartOfAPositionPaysYourBalance() {
        openSellSheet()
        XCTAssertTrue(button(startingWith: "Sell all for $22.80").exists, "Starts at the whole position")
        app.buttons["50%"].tap()
        let sell = button(startingWith: "Sell $11.40")
        XCTAssertTrue(sell.waitForExistence(timeout: 3))
        XCTAssertTrue(element(containing: "You make $1.40").exists, "Half the $2.80 gain")
        sell.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.staticTexts["Sell your trade"])
        waitForExpectations(timeout: 5)
        XCTAssertTrue(element(containing: "$11.40").waitForExistence(timeout: 5), "Half is left on the take page")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(element(containing: "$193.80").waitForExistence(timeout: 5), "$182.40 + $11.40")
    }

    func testSellingAllClosesThePosition() {
        openSellSheet()
        button(startingWith: "Sell all for $22.80").tap()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: app.staticTexts["Your position"])
        waitForExpectations(timeout: 5)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(element(containing: "$205.20").waitForExistence(timeout: 5), "$182.40 + $22.80")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "AI power demand")).firstMatch.exists,
                       "No longer an open position")
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Cash balance'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Sold"].waitForExistence(timeout: 5), "The sale shows in activity")
    }

    func testTradingAddsToYourPosition() {
        app.tabBars.buttons["Me"].firstMatch.tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "AI power demand")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Your position"].waitForExistence(timeout: 5))
        button(startingWith: "Trade this take").tap()
        app.buttons["$50"].tap()
        button(startingWith: "Trade for $50").tap()
        // $50 more at $1.14 is worth $50 now: $72.80 in all, $70 put in.
        XCTAssertTrue(element(containing: "$72.80").waitForExistence(timeout: 5))
        XCTAssertTrue(element(containing: "$70.00").exists)
    }

    func testCashOpensAndCloses() {
        // From the sidebar: close with ✕.
        app.buttons["Open profile menu"].tap()
        button(startingWith: "Cash activity").tap()
        XCTAssertTrue(app.staticTexts["Activity"].waitForExistence(timeout: 5))
        app.buttons["Close"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Open profile menu"].waitForExistence(timeout: 5), "Back on Home")
        XCTAssertFalse(app.staticTexts["Activity"].exists)

        // From Me: swipe it away.
        app.tabBars.buttons["Me"].tap()
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Cash balance'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Activity"].waitForExistence(timeout: 5))
        let top = app.navigationBars["Cash"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        top.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5), "Back on Me")
        XCTAssertFalse(app.staticTexts["Activity"].exists)
    }

    private func openEditProfile() {
        app.tabBars.buttons["Me"].tap()
        app.buttons["Edit profile"].tap()
        XCTAssertTrue(app.navigationBars["Edit profile"].waitForExistence(timeout: 5))
    }

    /// Clears a field and types new text. Taps at the far end so the cursor lands
    /// after the last character (a plain tap can land at the start of a multi-line field).
    private func replace(_ field: XCUIElement, with text: String) {
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        let current = (field.value as? String) ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
        field.typeText(text)
    }

    func testEditProfileUpdatesMe() {
        openEditProfile()
        XCTAssertFalse(app.buttons["Save"].isEnabled, "Nothing changed yet")

        replace(app.textFields["edit-name"], with: "Sarah K")
        replace(app.textFields["edit-handle"], with: "Sarah K!")
        XCTAssertEqual(app.textFields["edit-handle"].value as? String, "sarah_k", "Handle is cleaned up as you type")
        XCTAssertTrue(app.staticTexts["@sarah_k is available"].waitForExistence(timeout: 3))
        replace(app.textFields["edit-bio"], with: "Rates and copper.")
        app.buttons["Save"].tap()

        XCTAssertTrue(app.staticTexts["Sarah K"].waitForExistence(timeout: 5), "Me shows the new name")
        XCTAssertTrue(app.staticTexts["@sarah_k"].exists)
        XCTAssertTrue(app.staticTexts["Rates and copper."].exists)
        app.tabBars.buttons["Home"].tap()
        app.buttons["Open profile menu"].tap()
        XCTAssertTrue(app.staticTexts["Sarah K"].waitForExistence(timeout: 3), "Sidebar shows it too")
    }

    func testBioCanStartLowercase() {
        openEditProfile()
        replace(app.textFields["edit-bio"], with: "lowercase all the way.")
        XCTAssertEqual(app.textFields["edit-bio"].value as? String, "lowercase all the way.")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["lowercase all the way."].waitForExistence(timeout: 5))
    }

    func testEditProfileBlocksTakenHandle() {
        openEditProfile()
        replace(app.textFields["edit-handle"], with: "taken")
        XCTAssertTrue(app.staticTexts["@taken is taken"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Save"].isEnabled)
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Edit profile"].waitForExistence(timeout: 3))
    }

    func testWithdrawGuardsYourBalance() {
        app.buttons["Open profile menu"].tap()
        button(startingWith: "Withdraw").tap()
        XCTAssertTrue(app.navigationBars["Withdraw"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["$182.40 available"].exists)
        for key in ["5", "0", "0"] { app.buttons[key].tap() }
        XCTAssertTrue(app.staticTexts["That's more than you have"].exists)
        XCTAssertFalse(button(startingWith: "Withdraw $500").isEnabled)

        app.buttons["Max"].tap()
        button(startingWith: "Withdraw $182.40").tap()
        XCTAssertTrue(element(containing: "$182.40 on its way").waitForExistence(timeout: 6))
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["Balance $0.00. Add cash"].waitForExistence(timeout: 5), "Balance is empty after withdrawing it all")
    }

    func testFadeSheetLeavesOutUnshortableLeg() {
        onScreen(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Fade"))).tap()
        XCTAssertTrue(app.staticTexts["Fade Jake's take"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Left out"].exists, "Vistra can't be faded and should be shown as left out")
    }

    func testTakePageAndComments() {
        onScreen(app.staticTexts.matching(identifier: "AI power demand is underrated.")).tap()
        XCTAssertTrue(app.staticTexts["Basket"].waitForExistence(timeout: 5))
        app.swipeUp()
        app.buttons["See all"].tap()
        XCTAssertTrue(app.navigationBars["Comments · 12"].waitForExistence(timeout: 5))
        // The take page's own comment preview (Priya + Mo) stays under the sheet,
        // so count matches: with Faders on, Dev appears and Priya only shows once.
        // Commenter names are profile links, so they're buttons.
        app.buttons["Faders"].tap()
        XCTAssertTrue(app.buttons["Dev"].waitForExistence(timeout: 3), "Faders filter should show Dev's fade")
        XCTAssertEqual(app.buttons.matching(identifier: "Priya").count, 1, "Faders filter should hide Priya's trading comment in the sheet")
    }

    func testAvatarOpensSidebarAndSaved() {
        app.buttons["Open profile menu"].tap()
        XCTAssertTrue(app.staticTexts["@sarah"].waitForExistence(timeout: 3), "Sidebar shows your handle")
        button(startingWith: "Saved").tap()
        XCTAssertTrue(app.navigationBars["Saved"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Nuclear restarts get fast-tracked."].exists, "Seeded saved take is listed")
    }

    func testSwipeRightOpensSidebar() {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end)
        XCTAssertTrue(app.staticTexts["@sarah"].waitForExistence(timeout: 3), "Swiping right opens the sidebar")
    }

    func testBookmarkingAddsToSaved() {
        onScreen(app.buttons.matching(identifier: "Save")).tap()
        XCTAssertTrue(app.buttons["Remove from saved"].firstMatch.waitForExistence(timeout: 3))
        app.buttons["Open profile menu"].tap()
        button(startingWith: "Saved").tap()
        XCTAssertTrue(app.staticTexts["AI power demand is underrated."].waitForExistence(timeout: 5), "Saved take shows up in Saved")
    }

    func testFollowersAndFollowToggle() {
        app.buttons["Open profile menu"].tap()
        button(startingWith: "342 Followers").tap()
        XCTAssertTrue(app.staticTexts["Professional fader. Nothing personal."].waitForExistence(timeout: 5))
        // The sidebar is still closing as Followers slides in; wait for the row's button.
        let follow = app.buttons["Follow Dev"]
        XCTAssertTrue(follow.waitForExistence(timeout: 5), "Dev's Follow button")
        follow.tap()
        XCTAssertTrue(app.buttons["Unfollow Dev"].waitForExistence(timeout: 3))
        app.buttons["Following"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Dev"].waitForExistence(timeout: 3), "Dev appears under Following after following")
    }

    /// Horizontal drag across the middle of the screen. Starts on a button
    /// sometimes on purpose: a swipe there must page, not tap.
    private func drag(from: CGFloat, to: CGFloat, y: CGFloat = 0.45) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: from, dy: y))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: to, dy: y))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    func testSwipeBetweenForYouAndFollowing() {
        XCTAssertFalse(app.staticTexts["Nuclear restarts get fast-tracked."].exists, "Following page starts off-screen")
        drag(from: 0.85, to: 0.1)
        XCTAssertTrue(app.staticTexts["Nuclear restarts get fast-tracked."].waitForExistence(timeout: 3), "Swiping left shows Following")
        XCTAssertFalse(app.staticTexts["Chip stocks lead the next leg up."].exists, "For you is off-screen")
        drag(from: 0.15, to: 0.9)
        XCTAssertTrue(app.staticTexts["Chip stocks lead the next leg up."].waitForExistence(timeout: 3), "Swiping right goes back to For you")
        XCTAssertFalse(app.staticTexts["@sarah"].exists, "Paging back must not open the sidebar")
        XCTAssertFalse(app.staticTexts["Trade Mo's take"].exists, "A swipe starting on a Trade pill must not tap it")
        app.buttons["Following"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Nuclear restarts get fast-tracked."].waitForExistence(timeout: 3), "Tapping the tab pages too")
    }

    func testScoresOpensSidebarByTapAndSwipe() {
        app.tabBars.buttons["Scores"].tap()
        XCTAssertTrue(app.navigationBars["Scores"].waitForExistence(timeout: 5))
        app.buttons["Open profile menu"].tap()
        XCTAssertTrue(app.staticTexts["@sarah"].waitForExistence(timeout: 3), "Avatar on Scores opens the sidebar")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        XCTAssertTrue(app.staticTexts["@sarah"].waitForNonExistence(timeout: 3))
        drag(from: 0.1, to: 0.9)
        XCTAssertTrue(app.staticTexts["@sarah"].waitForExistence(timeout: 3), "Swiping right on Scores opens the sidebar")
    }

    func testTakeBarNeedsTextBeforeOpening() {
        XCTAssertFalse(app.buttons["accessory-start"].isEnabled, "Can't start an empty take")
        app.buttons["Your take"].tap()
        let field = app.textFields["Your take"]
        XCTAssertTrue(field.waitForExistence(timeout: 3), "Tapping the bar opens the compose bar")
        XCTAssertFalse(app.buttons["composer-start"].isEnabled)
        field.typeText("\n")
        XCTAssertTrue(field.waitForNonExistence(timeout: 3), "Return on an empty take just closes the composer")
        XCTAssertFalse(app.navigationBars["New take"].exists, "Nothing opens without text")
    }

    private func element(containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func testAddCashByCardUpdatesBalance() {
        app.buttons["Balance $182.40. Add cash"].tap()
        XCTAssertTrue(app.navigationBars["Add cash"].waitForExistence(timeout: 5))
        app.buttons["$100"].tap()
        app.buttons["Pay with Apple Pay. Change"].tap()
        button(startingWith: "Debit card").tap()
        button(startingWith: "Add $100").tap()
        XCTAssertTrue(element(containing: "+$100.00 added").waitForExistence(timeout: 6), "Shows the success screen")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["Balance $282.40. Add cash"].waitForExistence(timeout: 5), "Feed balance updates")
    }

    func testAddCashWithApplePay() {
        app.buttons["Balance $182.40. Add cash"].tap()
        XCTAssertTrue(app.navigationBars["Add cash"].waitForExistence(timeout: 5))
        let pay = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Buy with'")).firstMatch
        XCTAssertTrue(pay.waitForExistence(timeout: 3), "Apple Pay button")
        pay.tap()
        XCTAssertTrue(element(containing: "+$50.00 added").waitForExistence(timeout: 6))
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["Balance $232.40. Add cash"].waitForExistence(timeout: 5))
    }

    func testAddCashEnforcesMinimum() {
        app.buttons["Open profile menu"].tap()
        button(startingWith: "Add cash").tap()
        XCTAssertTrue(app.navigationBars["Add cash"].waitForExistence(timeout: 5), "Sidebar opens Add cash")
        app.buttons["Delete"].tap()
        app.buttons["Delete"].tap()
        XCTAssertTrue(app.staticTexts["Minimum is $10"].exists)
        app.buttons["Pay with Apple Pay. Change"].tap()
        button(startingWith: "Bank account").tap()
        XCTAssertFalse(button(startingWith: "Add $").isEnabled, "Can't add less than the minimum")
    }

    func testTransferInHidesDetailsUntilAsked() {
        app.buttons["Balance $182.40. Add cash"].tap()
        app.buttons["Pay with Apple Pay. Change"].tap()
        button(startingWith: "From another account").tap()
        XCTAssertTrue(app.staticTexts["Bring money from another account"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Copy"].exists, "Deposit details stay hidden at first")
        button(startingWith: "Show my deposit details").tap()
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 3))
    }

    func testCreateTakeFlow() {
        app.buttons["Your take"].tap()
        let field = app.textFields["Your take"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        XCTAssertTrue(field.isHittable, "Compose bar sits above the keyboard")
        field.typeText("Copper squeeze is coming.")
        app.buttons["composer-start"].tap()
        XCTAssertTrue(app.navigationBars["New take"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "Copper squeeze is coming.", "What you typed carries over")
        button(startingWith: "Build my basket").tap()
        let seeBasket = button(startingWith: "See your basket")
        XCTAssertTrue(seeBasket.waitForExistence(timeout: 10), "Building should finish")
        // The label animates in from "Building…"; wait for it to settle before tapping.
        expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: seeBasket)
        waitForExpectations(timeout: 5)
        seeBasket.tap()
        XCTAssertTrue(app.navigationBars["Your basket"].waitForExistence(timeout: 8))
        app.buttons["High risk"].tap()
        XCTAssertTrue(app.staticTexts["NVIDIA 2x"].waitForExistence(timeout: 3), "High risk adds the 2x leg")
        button(startingWith: "Buy in & post").tap()
        XCTAssertTrue(app.staticTexts["thesis"].waitForExistence(timeout: 5), "Posting returns to the feed")
    }
}
