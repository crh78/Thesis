import SwiftUI

struct ForkExitSheet: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    /// One quote per on-chain position; a holding bought more than once sells as one.
    @State private var quotes: [ForkBuild]?
    @State private var working = true
    @State private var error: String?
    let take: Take
    let positions: [String]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SellSheetHeader(title: "Sell position", claim: take.claim, busy: working)
                // A sale exits the whole position, is scored at the sale and settles right away,
                // and pays prediction legs' escrow back.
                Text(take.legs.contains(where: { $0.predictionSide != nil })
                     ? "Sells the whole position for fork USDC, including money held for prediction legs. It's scored at today's prices and settles right away."
                     : "Sells the whole position for fork USDC. It's scored at today's prices and settles right away.")
                    .foregroundStyle(Palette.muted)
                // The author's own buy-in: selling it closes the take for everyone.
                if quotes?.contains(where: { $0.closesTake == true }) == true {
                    Label("Selling closes this take: no new trades, and its result is final at today's prices. Others keep their positions.",
                          systemImage: "exclamationmark.triangle.fill")
                        .font(.geist(14, .medium))
                        .foregroundStyle(Palette.text)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassEffect(.regular, in: .rect(cornerRadius: 18))
                        .accessibilityIdentifier("fork-exit-closes-take")
                }
                if let quotes {
                    let expected = quotes.reduce(0) { $0 + ($1.expectedUsd ?? 0) }
                    let minimum = quotes.reduce(0) { $0 + ($1.minimumUsd ?? 0) }
                    LabeledContent("Estimated proceeds", value: Fmt.usd(expected, cents: true))
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("fork-exit-estimate")
                    LabeledContent("Minimum after slippage", value: Fmt.usd(minimum, cents: true))
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("fork-exit-minimum")
                }
                if let error { Text(error).foregroundStyle(Palette.down) }
                if working {
                    ThesisInlineLoader(text: quotes == nil ? "Getting a quote…" : "Selling…")
                } else if let quotes {
                    PrimaryGlassButton(title: "Confirm full sale") {
                        working = true
                        Task { await sell(quotes) }
                    }
                } else {
                    Button("Refresh quote") {
                        working = true
                        Task { await loadQuote() }
                    }
                    .buttonStyle(.bordered)
                }
                Spacer()
            }
            .padding(24)
            .background(ThesisBackground())
        }
        .presentationDetents([.fraction(0.8)])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(working)
        .task { await loadQuote() }
    }

    private func loadQuote() async {
        defer { working = false }
        error = nil
        do {
            var prepared: [ForkBuild] = []
            for position in positions {
                let quote = try await app.quoteForkExit(take, position: position)
                guard let expected = quote.expectedUsd, let minimum = quote.minimumUsd,
                      minimum > 0, expected >= minimum, quote.transactions.count == 1 else {
                    self.error = "The fork did not return a valid full-sale quote."
                    return
                }
                prepared.append(quote)
            }
            quotes = prepared
        }
        catch { self.error = error.localizedDescription }
    }

    /// The fork's errors are developer text ("Transaction simulation failed: Blockhash not found…").
    private static func friendly(_ error: Error) -> String {
        let text = error.localizedDescription
        if text.contains("Blockhash not found") || text.contains("block height exceeded") {
            return "The quote expired before it was sent. Refresh the quote and try again."
        }
        if text.contains("Simulation failed") || text.contains("simulation failed") {
            return "The sale didn't go through: prices moved past the slippage limit. Refresh the quote and try again."
        }
        return text
    }

    private func sell(_ quotes: [ForkBuild]) async {
        defer { working = false }
        error = nil
        do {
            // A built transaction expires about a minute after its blockhash, and the person may
            // have looked at the quote for longer: build each sale again right before signing.
            // The quote shown is the estimate; the program still enforces each sale's minimum.
            for position in positions {
                let fresh = try await app.quoteForkExit(take, position: position)
                try await app.confirmForkExit(fresh)
            }
            dismiss()
        } catch {
            // Whatever sold stays sold; the receipt shows what's left to sell.
            self.quotes = nil
            self.error = Self.friendly(error)
        }
    }
}
