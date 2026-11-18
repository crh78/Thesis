import SwiftUI
import PassKit
import ThinkingOrbsKit

/// Ways to add cash. Apple Pay / card / bank go through an onramp (Coinbase's
/// Apple Pay onramp is the plan, US-only); "another account" is a USDC
/// transfer for people who already hold some. All of it lands as dollars.
enum FundingMethod: String, CaseIterable, Identifiable {
    case applePay, debit, bank, transfer

    var id: String { rawValue }

    var title: String {
        switch self {
        case .applePay: "Apple Pay"
        case .debit: "Debit card"
        case .bank: "Bank account"
        case .transfer: "From another account"
        }
    }

    var detail: String {
        switch self {
        case .applePay: "Instant"
        case .debit: "Instant · Visa or Mastercard"
        case .bank: "1–3 business days · No fee"
        case .transfer: "Send USDC from Coinbase or a wallet"
        }
    }

    var arrival: String {
        switch self {
        case .applePay, .debit: "Arrives instantly"
        case .bank: "Arrives in 1–3 business days"
        case .transfer: "Arrives in a few minutes"
        }
    }

    var systemImage: String {
        switch self {
        case .applePay: "applelogo"
        case .debit: "creditcard"
        case .bank: "building.columns"
        case .transfer: "arrow.down.circle"
        }
    }

    // Withdrawing: where the money goes.
    var payoutTitle: String {
        switch self {
        case .applePay: "Apple Pay"
        case .debit: "Debit card"
        case .bank: "Bank account"
        case .transfer: "Another account"
        }
    }

    var payoutDetail: String {
        switch self {
        case .applePay: "Instant"
        case .debit: "Within 30 minutes · Visa or Mastercard"
        case .bank: "1–3 business days · No fee"
        case .transfer: "As USDC to Coinbase or a wallet"
        }
    }

    var payoutArrival: String {
        switch self {
        case .applePay, .debit: "Arrives within 30 minutes"
        case .bank: "Arrives in 1–3 business days"
        case .transfer: "Arrives in a few minutes"
        }
    }

    /// Apple Pay can't receive payouts.
    static let payouts: [FundingMethod] = [.bank, .debit]
}

private enum Phase: Equatable {
    case entering, processing, done(Double)
}

struct AddCashView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var entry = "50"
    @State private var method: FundingMethod = .applePay
    @State private var choosingMethod = false
    @State private var phase: Phase = .entering
    @State private var applePay = ApplePay()
    /// Why the last attempt didn't go through (from the server).
    @State private var failure: String?

    private let minimum: Double = 10
    private let dailyLimit: Double = 2_500
    private let presets: [Double] = [25, 50, 100, 250]

    private var amount: Double { Double(entry) ?? 0 }
    private var problem: String? {
        if let failure { return failure }
        if amount < minimum { return "Minimum is \(Fmt.usd(minimum))" }
        if amount > dailyLimit { return "Up to \(Fmt.usd(dailyLimit)) a day for now" }
        return nil
    }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .entering:
                    if method == .transfer { transferIn } else { amountEntry }
                case .processing:
                    processing
                case .done(let added):
                    success(added)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ThesisBackground())
            .navigationTitle(phase == .entering ? "Add cash" : "")
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
        .sheet(isPresented: $choosingMethod) {
            MethodPicker(selection: $method)
        }
        .interactiveDismissDisabled(phase == .processing)
        .onChange(of: entry) { failure = nil }
        .onChange(of: method) { failure = nil }
    }

    // MARK: Amount entry

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
                // Only speaks up when the amount won't work; no balance preview.
                Text(problem ?? " ")
                    .font(.mono(13))
                    .foregroundStyle(Palette.down)
                    .accessibilityHidden(problem == nil)
            }
            .padding(.horizontal, 24)

            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    ForEach(presets, id: \.self) { value in
                        GlassChip(title: Fmt.usd(value), selected: amount == value) {
                            entry = String(Int(value))
                        }
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
                        Text(method.title).font(.geist(15, .semibold))
                        Text(method.detail).font(.geist(12)).foregroundStyle(Palette.muted)
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
            .accessibilityLabel("Pay with \(method.title). Change")

            CashKeypad(entry: $entry)
                .padding(.horizontal, 24)
                .padding(.top, 10)

            VStack(spacing: 8) {
                if method == .applePay {
                    PayWithApplePayButton(.plain) { add() }
                        .payWithApplePayButtonStyle(.white)
                        .frame(height: 52)
                        .clipShape(Capsule())
                        .disabled(problem != nil)
                        .opacity(problem == nil ? 1 : 0.4)
                } else {
                    PrimaryGlassButton(title: "Add \(displayAmount)", action: add)
                        .disabled(problem != nil)
                }
                // The onramp (and its fee) isn't chosen yet: say nothing about a fee until it is.
                Text(app.isOnFork ? "Fake USDC on the mainnet fork, straight to your wallet" : "\(method.arrival) as dollars in your balance")
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
        let grouped = whole.formatted(.number.grouping(.automatic))
        return "$" + grouped + (parts.count > 1 ? "." + parts[1] : "")
    }

    private func add() {
        guard problem == nil else { return }
        let added = amount
        Task {
            if method == .applePay {
                // Real Apple Pay sheet: card, double-click, Face ID. Cancelling
                // leaves you on this screen; if iOS won't show the sheet yet
                // (no merchant ID), fall through to the simulated top-up.
                if await applePay.pay(added) == .cancelled { return }
            }
            withAnimation(.smooth) { phase = .processing }
            do {
                // Keep "Adding…" up long enough to read, even when the server is quick.
                async let pause: Void = Task.sleep(for: .seconds(0.9))
                try await app.deposit(added, method: method)
                try? await pause
                withAnimation(.smooth) { phase = .done(added) }
            } catch {
                failure = CashErrorText.message(for: error)
                withAnimation(.smooth) { phase = .entering }
            }
        }
    }

    // MARK: Transfer in

    /// For people who already hold USDC. Details stay hidden until asked for,
    /// so nobody sees an address by accident.
    private var transferIn: some View {
        TransferInView(onChangeMethod: { choosingMethod = true })
    }

    // MARK: Processing / success

    private var processing: some View {
        VStack(spacing: 18) {
            ThinkingOrb(state: .working, size: .px64)
            Text("Adding \(displayAmount)…").font(.geist(20, .semibold))
            Text("Hang tight, this only takes a moment.")
                .font(.geist(14))
                .foregroundStyle(Palette.muted)
        }
        .accessibilityElement(children: .combine)
    }

    private func success(_ added: Double) -> some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 14) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(Palette.up)
                    .symbolEffect(.bounce, value: phase)
                Text("\(Fmt.usd(added, cents: true, signed: true)) added")
                    .font(.geist(28, .bold))
                HStack(spacing: 6) {
                    Text("New balance").foregroundStyle(Palette.muted)
                    Text(Fmt.usd(app.balance, cents: true)).font(.mono(15, .semibold))
                }
                .font(.geist(15))
            }
            .accessibilityElement(children: .combine)
            Spacer()
            VStack(spacing: 10) {
                PrimaryGlassButton(title: "Trade a take", systemImage: "arrow.right") {
                    app.tab = .home
                    dismiss()
                }
                Button("Done") { dismiss() }
                    .font(.geist(15, .semibold))
                    .foregroundStyle(Palette.muted)
                    .frame(minHeight: 44)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
        .sensoryFeedback(.success, trigger: phase)
    }
}

// MARK: - Keypad

/// Cash App–style keypad; up to two decimals and a sensible max length.
/// Shared by Add cash and Withdraw.
struct CashKeypad: View {
    @Binding var entry: String

    private let keys: [String] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 3), spacing: 2) {
            ForEach(keys, id: \.self) { key in
                Button { press(key) } label: {
                    Group {
                        if key == "⌫" {
                            Image(systemName: "delete.left").font(.system(size: 22, weight: .medium))
                        } else {
                            Text(key).font(.geist(28, .medium))
                        }
                    }
                    .foregroundStyle(Palette.text)
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(key == "⌫" ? "Delete" : key == "." ? "Decimal point" : key)
            }
        }
        .sensoryFeedback(.selection, trigger: entry)
    }

    private func press(_ key: String) {
        switch key {
        case "⌫":
            entry = String(entry.dropLast())
            if entry.isEmpty { entry = "0" }
        case ".":
            if !entry.contains(".") { entry += "." }
        default:
            if let dot = entry.firstIndex(of: "."), entry.distance(from: dot, to: entry.endIndex) > 2 { return }
            if entry.replacingOccurrences(of: ".", with: "").count >= 6 { return }
            entry = entry == "0" ? key : entry + key
        }
    }
}

// MARK: - Method picker

private struct MethodPicker: View {
    @Binding var selection: FundingMethod
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(FundingMethod.allCases) { method in
                        Button {
                            selection = method
                            dismiss()
                        } label: {
                            HStack(spacing: 14) {
                                Image(systemName: method.systemImage)
                                    .font(.system(size: 18, weight: .medium))
                                    .frame(width: 30)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(method.title).font(.geist(16, .semibold))
                                    Text(method.detail).font(.geist(13)).foregroundStyle(Palette.muted)
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
                    Text("Card and Apple Pay are processed by our payments partner. Cash always shows up as dollars.")
                        .font(.geist(12))
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Pay with")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }
}

// MARK: - Transfer in

private struct TransferInView: View {
    let onChangeMethod: () -> Void
    @State private var revealed = false
    @State private var copied = false

    /// Placeholder until the backend issues a real deposit address per user.
    private let depositAddress = "[deposit address]"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Bring money from another account")
                        .font(.geist(24, .bold))
                    Text("Send USDC from Coinbase, another exchange, or a wallet. It shows up here as dollars, usually within a few minutes.")
                        .font(.geist(15))
                        .foregroundStyle(Palette.muted)
                }

                VStack(alignment: .leading, spacing: 0) {
                    step(1, "Choose Send or Withdraw USDC in your other app")
                    Hairline()
                    step(2, "Paste your Thesis deposit details")
                    Hairline()
                    step(3, "We convert it to dollars in your balance")
                }

                if revealed {
                    VStack(spacing: 14) {
                        QRCode(text: depositAddress)
                            .frame(width: 170, height: 170)
                            .padding(12)
                            .background(.white, in: .rect(cornerRadius: 20))
                            .accessibilityLabel("QR code for your deposit details")
                        Text(depositAddress)
                            .font(.mono(13))
                            .multilineTextAlignment(.center)
                            .textSelection(.enabled)
                        Button {
                            UIPasteboard.general.string = depositAddress
                            copied = true
                        } label: {
                            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                                .font(.geist(15, .semibold))
                                .frame(minWidth: 120, minHeight: 32)
                        }
                        .buttonStyle(.glass)
                        .sensoryFeedback(.success, trigger: copied)
                        Text("Works from Base, Ethereum, Arbitrum, Solana and other major networks. Only send USDC.")
                            .font(.geist(12))
                            .foregroundStyle(Palette.muted)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
                    .glassEffect(.regular, in: .rect(cornerRadius: 26))
                    .transition(.opacity.combined(with: .scale(scale: 0.97)))
                } else {
                    PrimaryGlassButton(title: "Show my deposit details") {
                        withAnimation(.smooth) { revealed = true }
                    }
                }

                Button("Use Apple Pay or a card instead", action: onChangeMethod)
                    .font(.geist(14, .semibold))
                    .foregroundStyle(Palette.muted)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(spacing: 12) {
            Text("\(n)")
                .font(.mono(13, .semibold))
                .frame(width: 26, height: 26)
                .background(Palette.tile, in: Circle())
            Text(text).font(.geist(15))
            Spacer()
        }
        .frame(minHeight: 50)
    }
}

/// QR code drawn with Core Image.
private struct QRCode: View {
    let text: String

    var body: some View {
        if let image = Self.make(text) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
        } else {
            Color.white
        }
    }

    private static func make(_ text: String) -> UIImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
