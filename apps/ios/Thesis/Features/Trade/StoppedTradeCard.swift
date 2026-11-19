import SwiftUI

/// A split trade that stopped partway (the fork API's `trade_incomplete`): part of it landed, so the
/// wallet holds tokens that aren't in a position. The owner's rule: retry once ("Finish the trade"),
/// and if that doesn't work, sweep them back to USDC ("Swap the leftover back to cash"). The app
/// runs the retry itself right after a trade stops (no tap, AppState.track), so the trade sheet
/// shows this only when that didn't finish it; Cash lists every stopped trade (`stoppedTrades`), so
/// one can be finished after a relaunch or from another device. As the web app's StoppedTrade.
struct StoppedTradeCard: View {
    @Environment(AppState.self) private var app
    let trade: ForkIncomplete?
    /// Cash's card: a smaller title, inside a glass card. The trade sheet's: a heading.
    var card = false
    /// Called once it's sorted out, with what to tell the user.
    let onDone: (String) -> Void

    @State private var canRetry: Bool
    @State private var busy: Action?
    @State private var error: String?

    private enum Action { case finish, sweep }

    init(trade: ForkIncomplete?, retry: Bool, card: Bool = false, onDone: @escaping (String) -> Void) {
        self.trade = trade
        self.card = card
        self.onDone = onDone
        _canRetry = State(initialValue: retry)
    }

    private var what: String {
        guard let trade else { return "Your trade" }
        return "Your \(Fmt.usd(trade.usd)) \(trade.isFade ? "fade" : "trade")"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(card ? "\(what) didn't finish" : "The trade didn't finish")
                .font(.geist(card ? 15 : 20, .semibold))
            Text("Part of it went through and the rest didn't, so some of your cash is in tokens that aren't in a position yet."
                 + (canRetry ? " Finish the trade, or swap them back to cash." : " Swap them back to have it as cash again."))
                .font(.geist(14))
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
            if let error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.geist(13, .medium))
                    .foregroundStyle(Palette.down)
                    .accessibilityIdentifier("stopped-trade-error")
            }
            VStack(spacing: 8) {
                if canRetry {
                    button(busy == .finish ? "Finishing the trade…" : "Finish the trade", filled: true, id: "stopped-trade-finish") {
                        run(.finish) { try await app.finishStoppedTrade(trade?.position) }
                    }
                }
                button(busy == .sweep ? "Swapping back to cash…" : "Swap the leftover back to cash", filled: !canRetry,
                       id: "stopped-trade-sweep") {
                    run(.sweep) { try await app.sweepStoppedTrade(trade?.position) }
                }
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("stopped-trade")
    }

    private func button(_ title: String, filled: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.geist(15, .semibold))
                .frame(maxWidth: .infinity, minHeight: card ? 44 : 50)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(filled ? Palette.bg : Palette.text)
        .glassEffect(filled ? .regular.tint(Palette.text).interactive() : .regular.interactive(), in: .capsule)
        .disabled(busy != nil)
        .accessibilityIdentifier(id)
    }

    private func run(_ action: Action, _ work: @escaping () async throws -> ForkAPI.Recovery) {
        guard busy == nil else { return }
        busy = action
        error = nil
        Task {
            do {
                onDone(AppState.recoveryText(try await work()))
            } catch let e as ForkAPIError where e.code == "trade_incomplete" || e.retry == false {
                // Only the sweep is left: the retry was used, can't be built, or stopped again.
                canRetry = false
                error = "Finishing it didn't work. Swap the leftover back to cash instead."
            } catch {
                self.error = CashErrorText.message(for: error)
            }
            busy = nil
        }
    }
}
