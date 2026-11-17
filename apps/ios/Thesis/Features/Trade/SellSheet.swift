import SwiftUI

struct SellSheet: View {
    private enum Position {
        case paper(OwnedPosition)
        case fork(Take, [String])
    }

    private let position: Position

    init(position: OwnedPosition) { self.position = .paper(position) }
    init(take: Take, forkPositions: [String]) { self.position = .fork(take, forkPositions) }

    var body: some View {
        switch position {
        case .paper(let holding): PaperSellSheet(position: holding)
        case .fork(let take, let addresses): ForkExitSheet(take: take, positions: addresses)
        }
    }
}

struct SellSheetHeader: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let claim: String
    var busy = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.geist(26, .bold))
                Text(claim).font(.serif(16)).foregroundStyle(Palette.muted).lineLimit(2)
            }
            Spacer()
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 15, weight: .semibold))
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .accessibilityLabel("Close")
            .disabled(busy)
        }
    }
}

/// Sell some or all of a position at today's price. The money goes back into
/// your balance; what you made (or lost) is the difference from what you paid.
///
/// Starts at the whole position. Any part from $1 works; asking for more than
/// it's worth sells it all.
private struct PaperSellSheet: View {
    let position: OwnedPosition

    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var amount: Double
    @State private var selling = false
    @State private var failure: String?
    @State private var sold = false
    @FocusState private var amountFocused: Bool

    init(position: OwnedPosition) {
        self.position = position
        _amount = State(initialValue: Self.cents(position.value))
    }

    private static func cents(_ v: Double) -> Double { (v * 100).rounded() / 100 }

    private var worth: Double { Self.cents(position.value) }
    private var all: Bool { amount >= worth }
    /// What this sale actually pays.
    private var proceeds: Double { all ? worth : amount }
    private var tooSmall: Bool { !all && amount < AppState.minTrade }
    /// Gain or loss on the part being sold.
    private var pnl: Double {
        guard position.value > 0 else { return -position.amount }
        return all ? worth - position.amount : amount - position.amount * amount / position.value
    }
    private var sideWord: String { position.side == .back ? "trade" : "fade" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                SellSheetHeader(title: "Sell your \(sideWord)", claim: position.take.claim, busy: selling)

                PositionFigures(position: position)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 14)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))

                if worth > 0 {
                    VStack(alignment: .leading, spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Amount to sell").font(.geist(12)).foregroundStyle(Palette.muted)
                            // "$22.80", not "$22.8"; whole dollars stay "$20".
                            TextField("Amount", value: $amount,
                                      format: .currency(code: "USD").precision(.fractionLength(amount == amount.rounded() ? 0 : 2)))
                                .font(.geist(34, .bold))
                                .keyboardType(.decimalPad)
                                .monospacedDigit()
                                .focused($amountFocused)
                                .accessibilityIdentifier("sell-amount")
                        }
                        .padding(.horizontal, 22)
                        .padding(.vertical, 12)
                        .glassEffect(.regular, in: .rect(cornerRadius: 28))

                        GlassEffectContainer(spacing: 8) {
                            HStack(spacing: 8) {
                                share("25%", 0.25)
                                share("50%", 0.5)
                                share("All", 1)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 22)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: amount) { failure = nil }
        .safeAreaBar(edge: .bottom) {
            VStack(spacing: 10) {
                if let failure {
                    Label(failure, systemImage: "exclamationmark.circle")
                        .font(.geist(13, .medium))
                        .foregroundStyle(Palette.down)
                }
                if tooSmall {
                    PrimaryGlassButton(title: "Sell at least \(Fmt.usd(AppState.minTrade))") {}
                        .disabled(true)
                } else {
                    PrimaryGlassButton(title: buttonTitle, action: sell)
                        .disabled(selling)
                        .accessibilityIdentifier("sell-confirm")
                }
                Text(caption)
                    .font(.geist(13))
                    .foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 8)
        }
        .presentationDetents([.fraction(0.8)])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(selling)
        .sensoryFeedback(.success, trigger: sold)
    }

    private func share(_ label: String, _ fraction: Double) -> some View {
        let value = fraction == 1 ? worth : Self.cents(worth * fraction)
        let on = abs(amount - value) < 0.005
        return Button {
            amountFocused = false
            withAnimation(.snappy) { amount = value }
        } label: {
            Text(label)
                .font(.mono(15, .semibold))
                .foregroundStyle(Palette.text)
                .frame(maxWidth: .infinity, minHeight: 48)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(on ? .regular.tint(position.side.fill.opacity(0.4)).interactive() : .regular.interactive(), in: .capsule)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var buttonTitle: String {
        if selling { return "Selling…" }
        if worth == 0 { return "Close position" }
        return all ? "Sell all for \(Fmt.usd(worth, cents: true))" : "Sell \(Fmt.usd(proceeds, cents: true))"
    }

    private var caption: String {
        if worth == 0 { return "It's worth $0 now, so there's nothing to pay out." }
        if tooSmall { return "The smallest sale is \(Fmt.usd(AppState.minTrade)), or sell it all." }
        let made = abs(pnl) < 0.005 ? "No gain or loss" : pnl > 0 ? "You make \(Fmt.usd(pnl, cents: true))" : "You lose \(Fmt.usd(-pnl, cents: true))"
        return "\(made) · \(Fmt.usd(proceeds, cents: true)) goes to your balance"
    }

    private func sell() {
        guard !selling else { return }
        selling = true
        failure = nil
        Task {
            do {
                try await app.sell(position, amount: all ? nil : amount)
                sold = true
                dismiss()
            } catch {
                failure = CashErrorText.message(for: error)
            }
            selling = false
        }
    }
}

/// Worth now, gain, what you put in, and the prices behind it.
struct PositionFigures: View {
    let position: OwnedPosition

    var body: some View {
        let p = position
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Worth now").font(.geist(12)).foregroundStyle(Palette.muted)
                    Text(Fmt.usd(p.value, cents: true)).font(.geist(28, .bold)).monospacedDigit()
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(p.pnl >= 0 ? "Gain" : "Loss").font(.geist(12)).foregroundStyle(Palette.muted)
                    Text("\(Fmt.usd(p.pnl, cents: true, signed: true)) (\(Fmt.pct(p.ret)))")
                        .font(.mono(15, .semibold))
                        .foregroundStyle(p.pnl >= 0 ? Palette.up : Palette.down)
                }
            }
            Hairline()
            figure("You put in", Fmt.usd(p.amount, cents: true))
            figure("Price", "\(Fmt.usd(p.avgPrice, cents: true)) avg → \(Fmt.usd(p.price, cents: true)) now")
            figure("Shares", String(format: "%.2f", p.shares))
        }
        .accessibilityElement(children: .combine)
    }

    private func figure(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.geist(13)).foregroundStyle(Palette.muted)
            Spacer()
            Text(value).font(.mono(13))
        }
    }
}
