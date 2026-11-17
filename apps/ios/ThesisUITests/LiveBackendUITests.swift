import XCTest

/// End-to-end against the real backend: signs in with Dev login, then checks
/// that saves, follows, comments and new takes are stored server-side (they're
/// still there after a relaunch).
///
/// Off by default: it writes to the shared Supabase project. Run with
///   TEST_RUNNER_THESIS_LIVE=1 TEST_RUNNER_DEV_USER=… TEST_RUNNER_DEV_PASS=… \
///   xcodebuild test … -only-testing:ThesisUITests/LiveBackendUITests
/// (needs Config/DevLogin.local.xcconfig so the Dev login link exists).
/// It cleans up what it creates where the app can (unsave, unfollow); test
/// comments and takes are named "[live test]" for cleanup in SQL.
final class LiveBackendUITests: XCTestCase {
    private var app: XCUIApplication!
    private let stamp = String(Int(Date().timeIntervalSince1970) % 100_000)
    private var devUser = ""
    private var devPass = ""

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        try XCTSkipUnless(env["THESIS_LIVE"] == "1", "Live backend tests are opt-in (TEST_RUNNER_THESIS_LIVE=1)")
        continueAfterFailure = false
        devUser = env["DEV_USER"] ?? ""
        devPass = env["DEV_PASS"] ?? ""
        app = XCUIApplication()
        app.launch()
        try signInIfNeeded()
    }

    /// Signed out: Dev login. It resets the test account, so onboarding
    /// runs every time; get through it (no bio, skip Add cash) to reach Home.
    private func signInIfNeeded() throws {
        let feedTabs = app.buttons["For you"]
        let devLogin = app.buttons["Dev login"]
        let onboarding = app.textFields["name-field"]
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !feedTabs.exists && !devLogin.exists && !onboarding.exists { usleep(250_000) }
        if feedTabs.exists { return }
        if onboarding.exists {
            onboard(bio: nil) // left mid-onboarding by an earlier run
        } else {
            XCTAssertTrue(devLogin.exists, "Neither the app, onboarding nor the Dev login link showed up")
            devLoginThroughOnboarding(bio: nil)
        }
        let skip = app.buttons["Skip for now"]
        if skip.waitForExistence(timeout: 20) { skip.tap() }
        XCTAssertTrue(feedTabs.waitForExistence(timeout: 30), "Signed in and reached Home")
    }

    /// From the welcome screen: Dev login, then the onboarding steps (profile with
    /// an optional bio, a face, Canada so there's no state question).
    private func devLoginThroughOnboarding(bio: String?) {
        app.buttons["Dev login"].tap()
        let field = app.textFields["dev-username"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(devUser)
        let password = app.secureTextFields["dev-password"]
        password.tap()
        password.typeText(devPass + "\n")
        XCTAssertTrue(app.textFields["name-field"].waitForExistence(timeout: 30), "Dev login starts onboarding")
        onboard(bio: bio)
    }

    /// The onboarding steps, from the profile step on.
    private func onboard(bio: String?) {
        let name = app.textFields["name-field"]
        if (name.value as? String) != "Dev" { retype(name, "Dev") }
        let handle = app.textFields["handle-field"]
        if (handle.value as? String) != "dev" { retype(handle, "dev") }
        XCTAssertTrue(app.staticTexts["@dev is available"].waitForExistence(timeout: 10))
        if let bio {
            // The keyboard is up from the handle; tap the bio by position.
            let field = app.textFields["bio-field"]
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).tap()
            field.typeText(bio)
        }
        app.buttons["Continue"].tap()

        XCTAssertTrue(app.staticTexts["Pick a profile photo"].waitForExistence(timeout: 20))
        // A tap during the cross-fade from the previous step can be dropped: retry.
        let country = app.buttons["country-row"]
        for _ in 0..<3 where !country.exists {
            app.buttons["Continue"].tap()
            _ = country.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(country.waitForExistence(timeout: 10))
        country.tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Canada")
        app.buttons["Canada"].firstMatch.tap()
        XCTAssertTrue(country.waitForExistence(timeout: 5))
        app.buttons["Continue"].tap()

        // The follow step (optional): skip it.
        XCTAssertTrue(app.staticTexts["Follow some callers"].waitForExistence(timeout: 20))
        app.buttons["Skip for now"].tap()
    }

    /// Single-line field: a plain tap puts the cursor at the end.
    private func retype(_ field: XCUIElement, _ text: String) {
        field.tap()
        let current = (field.value as? String) ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2) + text)
    }

    private func logOut() {
        app.tabBars.buttons["Me"].tap()
        let row = app.buttons["log-out"]
        for _ in 0..<6 where !row.isHittable { app.swipeUp() }
        row.tap()
        XCTAssertTrue(app.staticTexts["Log out of Thesis?"].waitForExistence(timeout: 5))
        onScreen(app.buttons.matching(identifier: "Log out")).tap()
        XCTAssertTrue(app.buttons["Dev login"].waitForExistence(timeout: 15), "Back on the welcome screen")
    }

    /// Onboarding with a bio, then the one-time Add cash step: the bio is saved
    /// on the server and the deposit lands in the balance.
    func testOnboardingWithBioThenAddCash() {
        waitForFeed()
        logOut()
        let bio = "[live test] onboarding bio \(stamp)"
        devLoginThroughOnboarding(bio: bio)

        XCTAssertTrue(app.staticTexts["Add cash to start trading"].waitForExistence(timeout: 30),
                      "Finishing onboarding offers Add cash")
        app.buttons["Add cash"].tap()
        XCTAssertTrue(app.navigationBars["Add cash"].waitForExistence(timeout: 5))
        app.buttons["$50"].tap()
        app.buttons["Pay with Apple Pay. Change"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Debit card'")).firstMatch.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Add $50'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '+$50.00 added'")).firstMatch
            .waitForExistence(timeout: 15), "Deposit went through")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["For you"].waitForExistence(timeout: 10), "The Add cash step closes once money's in")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Balance $'")).firstMatch.label
            .contains("50.00"), "Balance shows the deposit")

        relaunch()
        app.tabBars.buttons["Me"].tap()
        XCTAssertTrue(app.staticTexts[bio].waitForExistence(timeout: 15), "The onboarding bio came back from the server")
    }

    private func relaunch() {
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["For you"].waitForExistence(timeout: 20))
    }

    private func onScreen(_ query: XCUIElementQuery) -> XCUIElement {
        query.allElementsBoundByIndex.first { $0.isHittable } ?? query.firstMatch
    }

    private func waitForFeed() {
        XCTAssertTrue(app.staticTexts["AI power demand is underrated."].waitForExistence(timeout: 20),
                      "The seeded demo takes load from the backend")
    }

    func testFeedLoadsFromBackend() {
        waitForFeed()
        // Demo handles that only exist server-side (the mock data uses @mo / @dev).
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '@dev_chips'")).firstMatch
            .waitForExistence(timeout: 5) || app.staticTexts.matching(NSPredicate(format: "label CONTAINS '@jake'")).firstMatch.exists)
    }

    func testSavePersistsAcrossLaunches() {
        waitForFeed()
        // Make sure we start unsaved.
        let remove = app.buttons["Remove from saved"]
        if remove.exists { onScreen(app.buttons.matching(identifier: "Remove from saved")).tap(); sleep(2) }

        onScreen(app.buttons.matching(identifier: "Save")).tap()
        sleep(2) // let the request land
        relaunch()
        app.buttons["Open profile menu"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Saved'")).firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Saved"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.cells.count > 0 || app.staticTexts["AI power demand is underrated."].waitForExistence(timeout: 10),
                      "The saved take came back from the server after relaunch")

        // Clean up: open the take and unbookmark it (swipe actions are flaky in tests).
        let row = app.cells.firstMatch
        if row.exists {
            row.tap()
            let unsave = app.buttons["Remove from saved"]
            XCTAssertTrue(unsave.waitForExistence(timeout: 5))
            unsave.tap()
            sleep(2)
        }
    }

    func testFollowPersistsAndFillsFollowingFeed() {
        waitForFeed()
        onScreen(app.staticTexts.matching(identifier: "Nuclear restarts get fast-tracked.")).tap()
        let follow = app.buttons["Follow Mo"]
        let unfollow = app.buttons["Unfollow Mo"]
        XCTAssertTrue(follow.waitForExistence(timeout: 5) || unfollow.exists)
        if unfollow.exists { unfollow.tap(); sleep(2) }
        follow.tap()
        XCTAssertTrue(unfollow.waitForExistence(timeout: 5))
        sleep(2)

        relaunch()
        app.buttons["Following"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Nuclear restarts get fast-tracked."].waitForExistence(timeout: 10),
                      "Mo's take is in Following after a relaunch")

        // Clean up.
        onScreen(app.staticTexts.matching(identifier: "Nuclear restarts get fast-tracked.")).tap()
        XCTAssertTrue(unfollow.waitForExistence(timeout: 5))
        unfollow.tap()
        sleep(2)
    }

    func testCommentAndLikePersist() {
        waitForFeed()
        onScreen(app.staticTexts.matching(identifier: "AI power demand is underrated.")).tap()
        XCTAssertTrue(app.staticTexts["Basket"].waitForExistence(timeout: 5))
        app.swipeUp()
        app.buttons["See all"].tap()

        let text = "[live test] comment \(stamp)"
        let field = app.textFields["Comment"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(text)
        app.buttons["Post comment"].tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10), "Comment shows after posting")

        // Like the first comment that isn't liked yet.
        let likes = app.buttons.matching(identifier: "Like")
        let unlikesBefore = app.buttons.matching(identifier: "Unlike").count
        XCTAssertTrue(likes.firstMatch.waitForExistence(timeout: 5))
        likes.firstMatch.tap()
        sleep(2)

        relaunch()
        onScreen(app.staticTexts.matching(identifier: "AI power demand is underrated.")).tap()
        app.swipeUp()
        app.buttons["See all"].tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10), "Comment is still there after a relaunch")
        XCTAssertEqual(app.buttons.matching(identifier: "Unlike").count, unlikesBefore + 1, "The like came back from the server")

        // Clean up the like.
        app.buttons.matching(identifier: "Unlike").firstMatch.tap()
        sleep(2)
    }

    /// The balance pill's dollar amount, e.g. "Balance $30.00. Add cash" → 30.
    private func balance() -> Double? {
        let pill = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Balance $'")).firstMatch
        guard pill.waitForExistence(timeout: 10) else { return nil }
        // "30.00. Add cash": the amount ends at ". " (the sentence's full stop).
        let rest = pill.label.dropFirst("Balance $".count)
        let amount = rest.components(separatedBy: ". ").first ?? ""
        return Double(amount.replacingOccurrences(of: ",", with: ""))
    }

    private func waitForBalance(_ expected: Double, _ message: String) {
        let text = String(format: "Balance $%@. Add cash", expected.formatted(.number.precision(.fractionLength(2)).grouping(.automatic)))
        XCTAssertTrue(app.buttons[text].waitForExistence(timeout: 15), "\(message) (wanted \(text), have \(balance() ?? -1))")
    }

    func testDepositTradeWithdrawRoundTrip() throws {
        waitForFeed()
        let start = try XCTUnwrap(balance(), "Balance pill")

        // Deposit $50 by debit card.
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Balance $'")).firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Add cash"].waitForExistence(timeout: 5))
        app.buttons["$50"].tap()
        app.buttons["Pay with Apple Pay. Change"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Debit card'")).firstMatch.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Add $50'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '+$50.00 added'")).firstMatch
            .waitForExistence(timeout: 15), "Deposit went through")
        app.buttons["Done"].tap()
        waitForBalance(start + 50, "Deposit shows in the balance")

        // Trade $20 on the first take.
        onScreen(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Trade'"))).tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Trade for $20'")).firstMatch.tap()
        waitForBalance(start + 30, "Trading took $20")

        // It's all on the server.
        relaunch()
        waitForBalance(start + 30, "Balance came back from the server after a relaunch")
        app.buttons["Open profile menu"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Cash activity'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Traded"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Added cash"].exists)

        // Withdraw everything.
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Open profile menu"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Withdraw'")).firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Withdraw"].waitForExistence(timeout: 5))
        app.buttons["Max"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Withdraw $'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'on its way'")).firstMatch
            .waitForExistence(timeout: 15))
        app.buttons["Done"].tap()
        waitForBalance(0, "Withdrew it all")
    }

    /// Adds $10 to your newest position, then sells $10 of it back. Prices
    /// don't move yet, so the shared account ends exactly where it started.
    func testTradeThenSellRoundTrip() throws {
        waitForFeed()
        let start = try XCTUnwrap(balance(), "Balance pill")
        try XCTSkipIf(start < 10, "Needs $10 in the balance")

        app.tabBars.buttons["Me"].firstMatch.tap()
        let rows = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Traded,' OR label CONTAINS 'Faded,'"))
        try XCTSkipUnless(rows.firstMatch.waitForExistence(timeout: 15), "Needs an open position")
        let before = rows.firstMatch.label
        let claim = before.components(separatedBy: ",").first ?? before
        let side = before.contains("Faded") ? "fade" : "trade"
        rows.firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Your position"].waitForExistence(timeout: 10))

        // Add $10.
        let verb = side == "fade" ? "Fade" : "Trade"
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", side == "fade" ? "Fade" : "Trade this take")).firstMatch.tap()
        app.buttons["$10"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(verb) for $10")).firstMatch.tap()
        let tradeSheet = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "'s take")).firstMatch
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: tradeSheet)
        waitForExpectations(timeout: 15)

        // Sell $10 back.
        app.swipeUp()
        app.buttons["sell-\(side)"].tap()
        XCTAssertTrue(app.staticTexts["Sell your \(side)"].waitForExistence(timeout: 5))
        replace(app.textFields["sell-amount"], with: "10")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Sell $10'")).firstMatch.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.staticTexts["Sell your \(side)"])
        waitForExpectations(timeout: 15)

        // All on the server: same balance, same position, and the sale in activity.
        relaunch()
        waitForBalance(start, "Selling paid the $10 back")
        app.tabBars.buttons["Me"].firstMatch.tap()
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", claim)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertEqual(row.label, before, "The position is back where it started")
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Cash balance'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Sold"].waitForExistence(timeout: 10), "The sale shows in activity")
    }

    /// Clears a field and types new text (tap at the far end so the cursor is after the text).
    private func replace(_ field: XCUIElement, with text: String) {
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        let current = (field.value as? String) ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
        if !text.isEmpty { field.typeText(text) }
    }

    private func openEditProfile() {
        app.tabBars.buttons["Me"].tap()
        app.buttons["Edit profile"].tap()
        XCTAssertTrue(app.navigationBars["Edit profile"].waitForExistence(timeout: 5))
    }

    /// Edits name and bio (social + session) and picks a face (session), checks
    /// they come back from the server after a relaunch, then puts name and bio back.
    /// The photo is reset afterwards in SQL (the picker can't choose "no photo").
    func testEditProfilePersists() {
        waitForFeed()
        let name = "Dev Live \(stamp)"
        let bio = "[live test] bio \(stamp)"

        openEditProfile()
        replace(app.textFields["edit-name"], with: name)
        replace(app.textFields["edit-bio"], with: bio)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts[name].waitForExistence(timeout: 20), "Saved")

        // The photo: the face picker saves on its own.
        openEditProfile()
        app.buttons["Change photo"].tap()
        let face = app.buttons["avatar-option-person-07"]
        XCTAssertTrue(face.waitForExistence(timeout: 5), "The face picker opens")
        face.tap()
        // Two "Save" buttons exist: the editor's (behind the picker) and the picker's.
        onScreen(app.buttons.matching(identifier: "Save")).tap()
        let closed = NSPredicate(format: "exists == false")
        expectation(for: closed, evaluatedWith: face)
        waitForExpectations(timeout: 15)
        app.buttons["Cancel"].tap()

        relaunch()
        app.tabBars.buttons["Me"].tap()
        XCTAssertTrue(app.staticTexts[name].waitForExistence(timeout: 15), "Name came back from the server")
        XCTAssertTrue(app.staticTexts[bio].exists, "Bio came back from the server")

        // Put name and bio back.
        openEditProfile()
        replace(app.textFields["edit-name"], with: "Dev")
        replace(app.textFields["edit-bio"], with: "")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Dev"].waitForExistence(timeout: 20), "Restored")
        XCTAssertFalse(app.staticTexts[bio].exists)
    }

    func testPostingATakePutsItOnTop() {
        waitForFeed()
        // Needs a take the builder can trade (copper is only a perp, so it isn't).
        let claim = "[live test] Gold goes up as the dollar weakens \(stamp)."
        app.buttons["Your take"].tap()
        let field = app.textFields["Your take"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText(claim)
        app.buttons["composer-start"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Build my basket'")).firstMatch.tap()
        let seeBasket = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'See your basket'")).firstMatch
        XCTAssertTrue(seeBasket.waitForExistence(timeout: 20))
        let deadline = Date().addingTimeInterval(10)
        while !seeBasket.isHittable && Date() < deadline { usleep(250_000) }
        seeBasket.tap()
        app.buttons["Buy in & post"].tap()

        XCTAssertTrue(app.staticTexts[claim].waitForExistence(timeout: 15), "New take shows in For you")
        relaunch()
        XCTAssertTrue(app.staticTexts[claim].waitForExistence(timeout: 15), "New take is still there after a relaunch")
    }

    /// The take builder (cached catalog, BM25 search + one model call) picks real assets
    /// from the catalog, not the mock basket. Doesn't post.
    func testDisposableForkFullExit() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["THESIS_FORK_EXIT"] == "1", "Requires a disposable fork session")
        waitForFeed()
        let initial = try XCTUnwrap(balance())
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Balance $'")).firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Add cash"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Fake USDC on the mainnet fork, straight to your wallet"].exists)
        app.buttons["$50"].tap()
        app.buttons["Pay with Apple Pay. Change"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Debit card'")).firstMatch.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Add $50'")).firstMatch.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 55))
        app.buttons["Done"].tap()
        waitForBalance(initial + 50, "Fake cash deposited")

        app.open(try XCTUnwrap(URL(string: "yourthesis-dev://take/00000000-0000-4000-8000-000000000104")))
        let trade = app.buttons["Trade this take"].firstMatch
        XCTAssertTrue(trade.waitForExistence(timeout: 25))
        trade.tap()
        app.buttons["$10"].tap()
        let buy = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Trade for $10'")).firstMatch
        XCTAssertTrue(buy.waitForExistence(timeout: 15))
        let deadline = Date().addingTimeInterval(20)
        while !buy.isEnabled && Date() < deadline { usleep(250_000) }
        XCTAssertTrue(buy.isEnabled)
        let amount = app.textFields["trade-amount"]
        XCTAssertTrue(amount.exists)
        buy.tap()
        XCTAssertTrue(amount.waitForNonExistence(timeout: 75), "The signed buy confirmed")

        let sell = app.buttons["Sell position"].firstMatch
        for _ in 0..<5 where !sell.isHittable { app.swipeUp() }
        XCTAssertTrue(sell.waitForExistence(timeout: 15))
        let soldCount = app.staticTexts.matching(identifier: "Sold").count
        sell.tap()
        let confirm = app.buttons["Confirm full sale"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 50))
        XCTAssertTrue(app.descendants(matching: .any)["fork-exit-minimum"].firstMatch.exists)
        confirm.tap()
        XCTAssertTrue(confirm.waitForNonExistence(timeout: 75))
        let sold = app.staticTexts.matching(identifier: "Sold")
        expectation(for: NSPredicate { _, _ in sold.count > soldCount }, evaluatedWith: app)
        waitForExpectations(timeout: 25)
    }

    func testTakeBuilderPicksRealAssets() {
        waitForFeed()
        app.buttons["Your take"].tap()
        let field = app.textFields["Your take"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("AI power demand is underrated.")
        app.buttons["composer-start"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Build my basket'")).firstMatch.tap()

        let started = Date()
        let ready = app.staticTexts["Your basket is ready"]
        XCTAssertTrue(ready.waitForExistence(timeout: 20), "Basket built")
        print("take builder: basket ready after \(String(format: "%.1f", Date().timeIntervalSince(started))) s")

        let seeBasket = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'See your basket'")).firstMatch
        let deadline = Date().addingTimeInterval(10)
        while !seeBasket.isHittable && Date() < deadline { usleep(250_000) }
        seeBasket.tap()

        // Names only the real catalog has (the mock basket is Vistra/Constellation/NVIDIA).
        let real = ["Bloom Energy", "IREN", "TeraWulf", "CoreWeave", "Nebius Group", "Marvell Technology", "Global X Uranium ETF"]
        let found = NSPredicate(format: "label IN %@", real)
        XCTAssertTrue(app.staticTexts.matching(found).firstMatch.waitForExistence(timeout: 10), "Basket has real picks")
        XCTAssertFalse(app.staticTexts["Vistra"].exists, "Not the mock basket")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "take-builder-basket"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Asset search and pages come from the catalog with live prices, and a real basket can be
    /// changed by asking and by hand. Doesn't post.
    func testAssetsAndBasketEditing() {
        waitForFeed()
        app.tabBars.buttons["Search"].tap()
        app.segmentedControls["search-scope"].buttons["Assets"].tap()
        let search = app.searchFields.firstMatch
        search.tap()
        search.typeText("micron")
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Micron Technology'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "Search finds Micron")
        row.tap()
        XCTAssertTrue(app.staticTexts["asset-price"].waitForExistence(timeout: 15), "Live price")
        XCTAssertTrue(app.staticTexts["asset-takes-title"].exists)
        let page = XCTAttachment(screenshot: app.screenshot())
        page.name = "asset-page"
        page.lifetime = .keepAlways
        add(page)

        app.tabBars.buttons["Home"].tap()
        app.buttons["Your take"].tap()
        let field = app.textFields["Your take"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("Chip stocks go up.")
        app.buttons["composer-start"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Build my basket'")).firstMatch.tap()
        let seeBasket = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'See your basket'")).firstMatch
        XCTAssertTrue(seeBasket.waitForExistence(timeout: 20))
        let deadline = Date().addingTimeInterval(20)
        while !seeBasket.isHittable && Date() < deadline { usleep(250_000) }
        seeBasket.tap()

        let change = app.textFields["basket-change-field"]
        XCTAssertTrue(change.waitForExistence(timeout: 5))
        change.tap()
        change.typeText("add Bloom Energy\n")
        XCTAssertTrue(app.staticTexts["Bloom Energy"].waitForExistence(timeout: 15), "Asking adds the pick")

        app.buttons["basket-add-pick"].tap()
        let pickSearch = app.searchFields.firstMatch
        XCTAssertTrue(pickSearch.waitForExistence(timeout: 5))
        pickSearch.tap()
        pickSearch.typeText("quantum computing")
        let qubt = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Quantum Computing'")).firstMatch
        XCTAssertTrue(qubt.waitForExistence(timeout: 15), "The picker searches the catalog")
        qubt.tap()
        XCTAssertTrue(app.staticTexts["Quantum Computing"].waitForExistence(timeout: 5), "Adding by hand works")
        let basket = XCTAttachment(screenshot: app.screenshot())
        basket.name = "edited-basket"
        basket.lifetime = .keepAlways
        add(basket)
    }

    /// Settings → Privacy saves to the server (still off after a relaunch), and
    /// someone else's private list shows as private. For the second part set
    /// TEST_RUNNER_PRIVATE_HANDLE to a seeded handle whose following is hidden
    /// (e.g. update profiles set show_following = false where handle = 'priya').
    func testFollowPrivacyRoundTrip() {
        waitForFeed()
        openSettings()
        let toggle = app.switches["settings-show-following"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        if toggle.value as? String == "0" { toggle.switches.firstMatch.tap() } // left off by an earlier run
        toggle.switches.firstMatch.tap()
        XCTAssertEqual(toggle.value as? String, "0")
        sleep(2) // let the save land

        relaunch()
        openSettings()
        XCTAssertEqual(app.switches["settings-show-following"].value as? String, "0", "Off after a relaunch: saved server-side")
        app.switches["settings-show-following"].switches.firstMatch.tap() // back on for other runs
        XCTAssertEqual(app.switches["settings-show-following"].value as? String, "1")
        sleep(2)

        guard let handle = ProcessInfo.processInfo.environment["PRIVATE_HANDLE"], !handle.isEmpty else { return }
        app.navigationBars["Settings"].buttons.firstMatch.tap()
        app.tabBars.buttons["Scores"].tap()
        XCTAssertTrue(app.navigationBars["Scores"].waitForExistence(timeout: 5))
        let text = app.staticTexts.matching(identifier: "@\(handle)")
        let person = text.firstMatch.waitForExistence(timeout: 10) ? onScreen(text)
            : onScreen(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "@\(handle)")))
        XCTAssertTrue(person.waitForExistence(timeout: 5), "@\(handle) is on Scores")
        person.tap()
        let following = app.buttons["person-following"]
        XCTAssertTrue(following.waitForExistence(timeout: 10))
        XCTAssertTrue((following.label).hasSuffix("private"), "Their Following count shows a lock")
        following.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'keeps this private'")).firstMatch
                        .waitForExistence(timeout: 10), "Their following list is private")
    }

    private func openSettings() {
        // Right after a launch the first tap can be dropped while the session restores: retry.
        let settings = app.buttons["settings"]
        for _ in 0..<4 where !settings.exists {
            app.buttons["Open profile menu"].tap()
            _ = settings.waitForExistence(timeout: 3)
        }
        XCTAssertTrue(settings.exists, "Sidebar opened")
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    }
}
