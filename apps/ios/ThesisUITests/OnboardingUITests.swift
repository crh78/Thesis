import XCTest

/// Onboarding screens with stubbed actions (`-screen <name>`), so these run
/// without a network or a real Privy account.
final class OnboardingUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// Waits for an element to become enabled (it may be disabled while something async runs).
    private func waitUntilEnabled(_ element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == true"), object: element)
        return XCTWaiter().wait(for: [enabled], timeout: timeout) == .completed
    }

    private func launch(_ screen: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", screen]
        app.launch()
        return app
    }

    func testWelcomeOffersAllSignInMethods() {
        let app = launch("welcome")
        // "Continue with Apple" is behind APPLE_SIGN_IN_ENABLED (off until the paid Apple team), so not asserted here.
        XCTAssertTrue(app.buttons["Continue with Google"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Continue with email"].exists)
    }

    func testEmailFlowSendsCodeThenAsksForIt() {
        let app = launch("email")
        let send = app.buttons["Send code"]
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        XCTAssertFalse(send.isEnabled, "Send code should wait for a valid email")

        let field = app.textFields["email-field"]
        field.tap()
        field.typeText("sarah@example.com")
        XCTAssertTrue(send.isEnabled)
        send.tap()

        XCTAssertTrue(app.staticTexts["Enter the code"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["We sent a 6-digit code to sarah@example.com."].exists)
        XCTAssertTrue(app.buttons["Use a different email"].exists)
        app.buttons["Use a different email"].tap()
        XCTAssertTrue(app.staticTexts["What's your email?"].waitForExistence(timeout: 5))
    }

    func testHandleIsSanitizedAndTakenHandlesAreFlagged() {
        let app = launch("handle")
        let name = app.textFields["name-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.typeText("Sarah K")

        let handle = app.textFields["handle-field"]
        XCTAssertEqual(handle.value as? String, "sarah_k", "Handle should be suggested from the name")
        XCTAssertTrue(app.staticTexts["@sarah_k is available"].waitForExistence(timeout: 5))

        handle.tap()
        handle.press(forDuration: 1.0)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        handle.typeText("Taken!")
        XCTAssertEqual(handle.value as? String, "taken", "Handle should be lowercased with punctuation stripped")
        XCTAssertTrue(app.staticTexts["@taken is taken"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Continue"].isEnabled)
    }

    func testUSResidentsMustPickAState() {
        let app = launch("location")
        XCTAssertTrue(app.staticTexts["Where do you live?"].waitForExistence(timeout: 10))

        // Pick the US explicitly so the test doesn't depend on the simulator's region.
        app.buttons["country-row"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("United States")
        app.buttons["United States"].firstMatch.tap()

        let cont = app.buttons["Continue"]
        XCTAssertTrue(app.buttons["state-row"].waitForExistence(timeout: 5))
        XCTAssertFalse(cont.isEnabled, "US residents need a state")

        app.buttons["state-row"].tap()
        let stateSearch = app.searchFields.firstMatch
        XCTAssertTrue(stateSearch.waitForExistence(timeout: 5))
        stateSearch.tap()
        stateSearch.typeText("Texas")
        app.buttons["Texas"].firstMatch.tap()

        XCTAssertTrue(app.buttons["state-row"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["state-row"].label, "State, Texas")
        XCTAssertTrue(cont.isEnabled)
    }

    // MARK: Log out (mock data; doesn't touch a real session)

    private func launchSignedIn() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-skipAuth"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 10))
        return app
    }

    private func confirmLogOut(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts["Log out of Thesis?"].waitForExistence(timeout: 5), "Log out should ask to confirm")
        // The row that opened the dialog is also labelled "Log out"; tap the dialog's button.
        let confirm = app.buttons.matching(identifier: "Log out").allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(confirm)
        confirm?.tap()
        XCTAssertTrue(app.buttons["Continue with email"].waitForExistence(timeout: 10), "Log out returns to the welcome screen")
    }

    func testLogOutFromSidebar() {
        let app = launchSignedIn()
        app.buttons["Open profile menu"].tap()
        let row = app.buttons["log-out"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Sidebar has Log out at the bottom")
        row.tap()
        confirmLogOut(app)
    }

    func testLogOutFromProfile() {
        let app = launchSignedIn()
        app.tabBars.buttons["Me"].tap()
        let row = app.buttons["log-out"]
        for _ in 0..<6 where !row.isHittable { app.swipeUp() }
        XCTAssertTrue(row.isHittable, "Profile has Log out at the bottom")
        row.tap()
        confirmLogOut(app)
    }

    func testAvatarPickerFacesColorsAndShuffle() {
        let app = launch("avatar")
        let preview = app.otherElements["avatar-preview"]
        XCTAssertTrue(app.staticTexts["Pick a profile photo"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Upload photo"].exists, "Can upload your own photo")

        app.buttons["avatar-option-person-03"].tap()
        XCTAssertEqual(preview.label, "Avatar 3", "Tapping a face shows it in the preview")
        XCTAssertTrue(app.buttons["avatar-option-person-03"].isSelected)

        app.buttons["avatar-color-1"].tap()
        XCTAssertTrue(app.buttons["avatar-color-1"].isSelected, "Tapping a color selects it")

        app.buttons["Shuffle"].tap()
        XCTAssertNotEqual(preview.label, "Avatar 3", "Shuffle picks a different face")
        XCTAssertTrue(app.buttons["Continue"].isEnabled)

        // Men / Women filter: person-01…17 are men, 18…33 women.
        app.buttons["Women"].tap()
        XCTAssertTrue(app.buttons["avatar-option-person-18"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["avatar-option-person-01"].exists, "Women hides men")
        app.buttons["Shuffle"].tap()
        let shuffled = Int(preview.label.dropFirst(7)) ?? 0
        XCTAssertTrue((18...33).contains(shuffled), "Shuffle stays within the filter")
        app.buttons["Men"].tap()
        XCTAssertTrue(app.buttons["avatar-option-person-01"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["avatar-option-person-18"].exists, "Men hides women")
        let sikh = app.buttons["avatar-option-person-12"]
        for _ in 0..<3 where !sikh.exists { app.swipeUp() }
        XCTAssertTrue(sikh.exists, "The Sikh face (person-12) is under Men")
        app.swipeDown()
        app.buttons["All"].tap()
        XCTAssertTrue(app.buttons["avatar-option-person-18"].waitForExistence(timeout: 3))
    }

    func testFollowStepIsOptionalAndFollowsToggle() {
        let app = launch("follows")
        XCTAssertTrue(app.staticTexts["Follow some callers"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Skip for now"].exists, "Following anyone is optional")
        app.buttons["Follow Priya"].tap()
        XCTAssertTrue(app.buttons["Unfollow Priya"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Continue"].exists, "Footer says Continue once you follow someone")
        app.buttons["Unfollow Priya"].tap()
        XCTAssertTrue(app.buttons["Skip for now"].waitForExistence(timeout: 3))
    }

    func testProfileStepTakesAnOptionalBio() {
        let app = launch("handle")
        let name = app.textFields["name-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.typeText("Sarah K")
        // The name fills in a handle, and Continue waits for its availability check (debounced,
        // then the server or the mock): it's disabled while "Checking…", by design.
        XCTAssertTrue(waitUntilEnabled(app.buttons["Continue"]), "The bio is optional")

        let bio = app.textFields["bio-field"]
        XCTAssertTrue(bio.exists, "Profile step has a bio field")
        bio.tap()
        bio.typeText("rates, copper, and vibes.")
        XCTAssertEqual(bio.value as? String, "rates, copper, and vibes.", "A bio can start lowercase")
        XCTAssertTrue(app.staticTexts["25/160"].exists, "Shows the character count")
        XCTAssertTrue(app.buttons["Continue"].isEnabled)
    }

    func testAddCashStepAfterOnboarding() {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "startcash"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Add cash to start trading"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Skip for now"].exists, "It's optional")
        app.buttons["Add cash"].tap()
        XCTAssertTrue(app.navigationBars["Add cash"].waitForExistence(timeout: 5), "Opens Add cash")
    }

    func testNonUSResidentsSkipTheStateQuestion() {
        let app = launch("location")
        XCTAssertTrue(app.buttons["country-row"].waitForExistence(timeout: 10))
        app.buttons["country-row"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Canada")
        app.buttons["Canada"].firstMatch.tap()

        XCTAssertTrue(app.buttons["country-row"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["state-row"].exists)
        XCTAssertTrue(app.buttons["Continue"].isEnabled)
    }
}
