import PassKit

/// Presents the real Apple Pay sheet (card, "Double-click to pay", Face ID).
///
/// iOS only shows the sheet to apps that have an Apple Pay merchant ID and the
/// in-app payments entitlement, which need the paid Apple Developer Program.
/// Until those exist, `pay` returns `.unavailable` and the caller falls back to
/// the simulated top-up. When the onramp provider is wired, its own Apple Pay
/// flow replaces this.
@MainActor
final class ApplePay: NSObject, PKPaymentAuthorizationControllerDelegate {
    enum Outcome { case paid, cancelled, unavailable }

    /// Register this in the Apple Developer portal once enrolled.
    static let merchantID = "merchant.xyz.yourthesis.app"

    private var controller: PKPaymentAuthorizationController?
    private var authorized = false
    private var continuation: CheckedContinuation<Outcome, Never>?

    /// `APPLE_PAY_ENABLED` in project.yml. Without the merchant entitlement iOS
    /// closes the sheet straight away, which would look like a dead button.
    static var isEnabled: Bool {
        (Bundle.main.object(forInfoDictionaryKey: "ThesisApplePayEnabled") as? String) == "YES"
    }

    func pay(_ amount: Double) async -> Outcome {
        guard Self.isEnabled, PKPaymentAuthorizationController.canMakePayments() else { return .unavailable }

        let request = PKPaymentRequest()
        request.merchantIdentifier = Self.merchantID
        request.countryCode = "US"
        request.currencyCode = "USD"
        request.supportedNetworks = [.visa, .masterCard, .amex, .discover]
        request.merchantCapabilities = [.threeDSecure, .debit]
        request.paymentSummaryItems = [
            PKPaymentSummaryItem(label: "Thesis balance", amount: NSDecimalNumber(value: amount))
        ]

        let controller = PKPaymentAuthorizationController(paymentRequest: request)
        controller.delegate = self
        self.controller = controller
        authorized = false

        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            controller.present { presented in
                if !presented { self.finish(.unavailable) }
            }
        }
    }

    private func finish(_ outcome: Outcome) {
        continuation?.resume(returning: outcome)
        continuation = nil
        controller = nil
    }

    // MARK: PKPaymentAuthorizationControllerDelegate

    nonisolated func paymentAuthorizationController(
        _ controller: PKPaymentAuthorizationController,
        didAuthorizePayment payment: PKPayment,
        handler completion: @escaping (PKPaymentAuthorizationResult) -> Void
    ) {
        // The token goes to the payments partner here once it's wired.
        MainActor.assumeIsolated { authorized = true }
        completion(PKPaymentAuthorizationResult(status: .success, errors: nil))
    }

    nonisolated func paymentAuthorizationControllerDidFinish(_ controller: PKPaymentAuthorizationController) {
        MainActor.assumeIsolated {
            let outcome: Outcome = authorized ? .paid : .cancelled
            controller.dismiss { self.finish(outcome) }
        }
    }
}
