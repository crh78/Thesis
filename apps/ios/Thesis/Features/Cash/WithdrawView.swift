import SwiftUI
import ThinkingOrbsKit

private enum WithdrawPhase: Equatable {
    case entering, processing, done(Double)
}

/// Take money out of your balance, to a bank account or debit card.
/// Payouts are simulated until an offramp provider exists; the ledger is real.
struct WithdrawView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var entry = "0"
    @State private var method: FundingMethod = .bank
    @State private var choosingMethod = false
    @State private var phase: WithdrawPhase = .entering
    @State private var failure: String?

    private let minimum: Double = 1

    private var amount: Double { Double(entry) ?? 0 }
    private var problem: String? {
        if let failure { return failure }
        if amount == 0 { return nil }
        if amount > app.balance { return "That's more than you have" }
        if amount < minimum { return "Minimum is \(Fmt.usd(minimum, cents: true))" }
        return nil
    }
    private var canWithdraw: Bool { amount >= minimum && problem == nil }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .entering: amountEntry
                case .processing: processing
                case .done(let sent): success(sent)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ThesisBackground())
            .navigationTitle(phase == .entering ? "Withdraw" : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if phase == .entering {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { dismiss() } label: { Image(systemName: "xmark") }
                            .accessibilityLabel("Close")
                    }
                }
            }
        }
        .sheet(isPresented: $choosingMethod) { PayoutPicker(selection: $method) }
        .interactiveDismissDisabled(phase == .processing)
        .onChange(of: entry) { failure = nil }
        .onChange(of: method) { failure = nil }
    }

    // MARK: Amount

    private var amountEntry: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 8)

            VStack(spacing: 8) {
                Text(displayAmount)
                    .font(.geist(64, .bold))
                    .monospacedDigit()
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .contentTransition(.numericText())
                    .animation(.snappy, value: entry)
                    .accessibilityLabel("Amount \(displayAmount)")
                Group {
                    if let problem {
                        Text(problem).foregroundStyle(Palette.down)
                    } else {
                        Text("\(Fmt.usd(app.balance, cents: true)) available").foregroundStyle(Palette.muted)
                    }
                }
                .font(.mono(13))
            }
            .padding(.horizontal, 24)

            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    ForEach([25.0, 50, 100], id: \.self) { value in
                        GlassChip(title: Fmt.usd(value), selected: amount == value) {
                            entry = String(Int(value))
                        }
                    }
                    GlassChip(title: "Max", selected: amount > 0 && amount == app.balance) {
                        entry = Self.entry(for: app.balance)
                    }
                }
            }
            .padding(.top, 22)

            Spacer(minLength: 8)

            Button { choosingMethod = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: method.systemImage)
                        .font(.system(size: 18, weight: .medium))
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("To \(method.payoutTitle)").font(.geist(15, .semibold))
                        Text(method.payoutDetail).font(.geist(12)).foregroundStyle(Palette.muted)
                    }
                    Spacer()
                    Text("Change").font(.geist(13, .semibold)).foregroundStyle(Palette.muted)
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.muted)
                }
                .foregroundStyle(Palette.text)
                .padding(.horizontal, 18)
                .frame(minHeight: 60)
                .contentShape(.rect(cornerRadius: 22))
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
            .padding(.horizontal, 16)
            .accessibilityLabel("Send to \(method.payoutTitle). Change")

            CashKeypad(entry: $entry)
                .padding(.horizontal, 24)
                .padding(.top, 10)

            VStack(spacing: 8) {
                PrimaryGlassButton(title: amount > 0 ? "Withdraw \(displayAmount)" : "Withdraw", action: withdraw)
                    .disabled(!canWithdraw)
                Text("\(method.payoutArrival) · No fee")
                    .font(.geist(12))
                    .foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 8)
        }
    }

    private var displayAmount: String {
        let parts = entry.split(separator: ".", omittingEmptySubsequences: false)
        let whole = Int(parts.first ?? "0") ?? 0
        return "$" + whole.formatted(.number.grouping(.automatic)) + (parts.count > 1 ? "." + parts[1] : "")
    }

    /// The keypad's text for a dollar amount ("182.4" → "182.40", "50" stays "50").
    private static func entry(for value: Double) -> String {
        let cents = Int((value * 100).rounded())
        return cents % 100 == 0 ? String(cents / 100) : String(format: "%d.%02d", cents / 100, cents % 100)
    }

    private func withdraw() {
        guard canWithdraw else { return }
        let sent = amount
        withAnimation(.smooth) { phase = .processing }
        Task {
            do {
                async let pause: Void = Task.sleep(for: .seconds(0.9))
                try await app.withdraw(sent, method: method)
                try? await pause
                withAnimation(.smooth) { phase = .done(sent) }
            } catch {
                failure = CashErrorText.message(for: error)
                withAnimation(.smooth) { phase = .entering }
            }
        }
    }

    // MARK: Processing / success

    private var processing: some View {
        VStack(spacing: 18) {
            ThinkingOrb(state: .working, size: .px64)
            Text("Sending \(displayAmount)…").font(.geist(20, .semibold))
        }
        .accessibilityElement(children: .combine)
    }

    private func success(_ sent: Double) -> some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 14) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(Palette.up)
                    .symbolEffect(.bounce, value: phase)
                Text("\(Fmt.usd(sent, cents: true)) on its way")
                    .font(.geist(28, .bold))
                Text("\(method.payoutArrival) to your \(method.payoutTitle.lowercased()).")
                    .font(.geist(15))
                    .foregroundStyle(Palette.muted)
                HStack(spacing: 6) {
                    Text("Balance").foregroundStyle(Palette.muted)
                    Text(Fmt.usd(app.balance, cents: true)).font(.mono(15, .semibold))
                }
                .font(.geist(15))
            }
            .multilineTextAlignment(.center)
            .padding(.horizontal, 24)
            .accessibilityElement(children: .combine)
            Spacer()
            PrimaryGlassButton(title: "Done") { dismiss() }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
        }
        .sensoryFeedback(.success, trigger: phase)
    }
}

private struct PayoutPicker: View {
    @Binding var selection: FundingMethod
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(FundingMethod.payouts) { method in
                        Button {
                            selection = method
                            dismiss()
                        } label: {
                            HStack(spacing: 14) {
                                Image(systemName: method.systemImage)
                                    .font(.system(size: 18, weight: .medium))
                                    .frame(width: 30)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(method.payoutTitle).font(.geist(16, .semibold))
                                    Text(method.payoutDetail).font(.geist(13)).foregroundStyle(Palette.muted)
                                }
                                Spacer()
                                if method == selection {
                                    Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold))
                                }
                            }
                            .foregroundStyle(Palette.text)
                            .frame(minHeight: 52)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(method == selection ? .isSelected : [])
                    }
                } footer: {
                    Text("Payouts are handled by our payments partner and arrive as dollars.")
                        .font(.geist(12))
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Send to")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }
}
