import SwiftUI

/// Shown once, right after onboarding: add cash now so you can trade, or skip.
struct StartWithCashView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false

    var body: some View {
        NavigationStack {
            OnboardingScaffold(title: "Add cash to start trading",
                               subtitle: "Trade the takes you believe in and fade the ones you don't.") {
                VStack(alignment: .leading, spacing: 0) {
                    point("dollarsign.circle", "Trade or fade any take with as little as \(Fmt.usd(AppState.minTrade)).")
                    Hairline()
                    point("applelogo", "Add with Apple Pay, a debit card or your bank. It shows up as dollars.")
                    Hairline()
                    point("arrow.uturn.backward.circle", "Withdraw whenever you want.")
                }
            } footer: {
                VStack(spacing: 6) {
                    OnboardingButton(title: "Add cash", systemImage: "plus", style: .filled) { adding = true }
                    Button("Skip for now") { dismiss() }
                        .font(.geist(15, .semibold))
                        .foregroundStyle(Palette.muted)
                        .frame(minHeight: 44)
                }
            }
            .background(ThesisBackground())
        }
        // Once money's in, there's nothing left to do here.
        .sheet(isPresented: $adding, onDismiss: { if app.balance > 0 { dismiss() } }) {
            AddCashView()
        }
    }

    private func point(_ systemImage: String, _ text: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 20, weight: .medium))
                .frame(width: 28)
            Text(text).font(.geist(16))
            Spacer(minLength: 0)
        }
        .frame(minHeight: 60)
        .accessibilityElement(children: .combine)
    }
}
