import SwiftUI

/// Cash as a sheet with a close button, like Add cash and Withdraw.
struct CashSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            CashView()
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { dismiss() } label: { Image(systemName: "xmark") }
                            .accessibilityLabel("Close")
                    }
                }
        }
    }
}

/// Your cash: balance, Add cash / Withdraw, and everything that moved it.
/// Add cash and Withdraw open on top of it, so you land back here after.
struct CashView: View {
    @Environment(AppState.self) private var app
    @State private var addingCash = false
    @State private var withdrawing = false
    @State private var cashingOut = false
    @State private var cashOutError: String?

    var body: some View {
        let parts = Fmt.splitCents(app.balance, signed: false)

        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Cash balance").font(.geist(14)).foregroundStyle(Palette.muted)
                    HStack(spacing: 0) {
                        Text(parts.whole)
                        Text(parts.cents).foregroundStyle(Palette.muted)
                    }
                    .font(.geist(44, .bold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Balance \(Fmt.usd(app.balance, cents: true))")
                }
                .padding(.horizontal, 18)
                .padding(.top, 8)

                GlassEffectContainer(spacing: 10) {
                    HStack(spacing: 10) {
                        Button { addingCash = true } label: {
                            Label("Add cash", systemImage: "plus")
                                .font(.geist(15, .semibold))
                                .frame(maxWidth: .infinity, minHeight: 50)
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .glassEffect(.regular.tint(Palette.text).interactive(), in: .capsule)
                        .foregroundStyle(Palette.bg)

                        // Play money can't leave the fork.
                        if !app.isOnFork {
                            Button { withdrawing = true } label: {
                                Label("Withdraw", systemImage: "arrow.up")
                                    .font(.geist(15, .semibold))
                                    .frame(maxWidth: .infinity, minHeight: 50)
                                    .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                            .glassEffect(.regular.interactive(), in: .capsule)
                            .disabled(app.balance <= 0)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 18)

                if let phoenix = app.phoenixCash, phoenix.cashUsd > 0.005 || phoenix.openPositions > 0 {
                    phoenixCard(phoenix)
                }

                Text("Activity")
                    .font(.geist(17, .semibold))
                    .padding(.horizontal, 18)
                    .padding(.top, 28)
                    .padding(.bottom, 6)

                if app.cashActivity.isEmpty {
                    Text("Deposits, withdrawals, trades and fades show up here.")
                        .font(.geist(14))
                        .foregroundStyle(Palette.muted)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 20)
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(app.cashActivity) { entry in
                            CashEntryRow(entry: entry)
                            Hairline().padding(.leading, 66)
                        }
                    }
                }
            }
            .padding(.bottom, 24)
        }
        .background(ThesisBackground())
        .navigationTitle("Cash")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await app.refreshCash() }
        .task { await app.refreshCash() }
        .sheet(isPresented: $addingCash) { AddCashView() }
        .sheet(isPresented: $withdrawing) { WithdrawView() }
    }

    /// Money still on Phoenix: a sale's leveraged legs, or positions left open after a take settled.
    @ViewBuilder
    private func phoenixCard(_ phoenix: ForkPhoenixCash) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(phoenix.openPositions > 0 ? "Leveraged positions still open" : "Cash from leveraged legs")
                .font(.geist(15, .semibold))
            Text(phoenix.openPositions > 0
                 ? "\(phoenix.markets.joined(separator: ", ")) kept moving after the take ended. Cash out to close and add it to your balance."
                 : "\(Fmt.usd(phoenix.cashUsd, cents: true)) is waiting to come back to your balance.")
                .font(.geist(14))
                .foregroundStyle(Palette.muted)
            if let cashOutError {
                Text(cashOutError).font(.geist(13)).foregroundStyle(Palette.muted)
            }
            Button {
                cashingOut = true
                cashOutError = nil
                Task {
                    do { try await app.cashOutPhoenix() } catch { cashOutError = "Couldn't cash out. Try again." }
                    cashingOut = false
                }
            } label: {
                Text(cashingOut ? "Cashing out…" : "Cash out")
                    .font(.geist(15, .semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .capsule)
            .disabled(cashingOut)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
        .padding(.horizontal, 16)
        .padding(.top, 18)
    }
}

private struct CashEntryRow: View {
    let entry: CashEntry

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: entry.systemImage)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 36, height: 36)
                .background(Palette.tile, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title).font(.geist(15, .semibold))
                Text(entry.detail).font(.geist(13)).foregroundStyle(Palette.muted).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(Fmt.usd(entry.amount, cents: true, signed: true))
                    .font(.mono(14, .semibold))
                    .foregroundStyle(entry.amount > 0 ? Palette.up : Palette.text)
                Text(RelativeAge.short(since: entry.date)).font(.mono(11)).foregroundStyle(Palette.muted)
            }
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 62)
        .accessibilityElement(children: .combine)
    }
}
