import SwiftUI
import os

/// Sells a whole fork position. The sale is built as the sheet opens (one build per on-chain
/// position; a holding bought more than once sells as one) and kept fresh while it's open, so
/// Confirm only signs and sends it. It shows "Sold" once the fork accepts it; if it then doesn't
/// land, the sheet (or a banner, once it's closed) says so: you still hold the position.
struct ForkExitSheet: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    /// One quote per on-chain position, as first built: what the sheet shows.
    @State private var quotes: [ForkBuild]?
    @State private var working = true
    @State private var error: String?
    /// Builds made ahead of Confirm, by position.
    @State private var prebuilds: Prebuilds<String>?
    /// Sales the fork accepted (build ids), while the sheet shows "Sold".
    @State private var confirming: [String] = []
    /// The app is in front: builds are kept fresh only then.
    @State private var active = true
    let take: Take
    let positions: [String]

    private static let log = Logger(subsystem: "xyz.yourthesis.app", category: "trade")

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
                if !confirming.isEmpty {
                    Label("Sold · Confirming on-chain…", systemImage: "checkmark.circle.fill")
                        .font(.geist(15, .semibold))
                        .accessibilityIdentifier("fork-exit-sold")
                } else if working {
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
        .interactiveDismissDisabled(working && confirming.isEmpty)
        .task {
            let app = app, take = take
            prebuilds = Prebuilds(
                build: { position, prebuild in try await app.prepareExit(take, position: position, prebuild: prebuild) },
                refresh: { try await app.refreshPrepared($0) })
            await loadQuote()
            // Keeps the sales' builds fresh while the sheet is up and the app in front.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                if active, confirming.isEmpty, !working, quotes != nil { positions.forEach { prebuilds?.tick($0) } }
            }
        }
        .onChange(of: scenePhase) { _, phase in active = phase == .active }
        .onDisappear { confirming.forEach { app.sheetShows($0, false) } }
    }

    /// Builds each position's sale ahead of Confirm, and shows what it's expected to pay.
    private func loadQuote() async {
        defer { working = false }
        error = nil
        guard let prebuilds else { return }
        prebuilds.reset()
        positions.forEach { prebuilds.want($0) }
        do {
            var prepared: [ForkBuild] = []
            for position in positions {
                // Waits for the build just asked for; it stays ready for Confirm.
                let quote = try await prebuilds.made(position).build
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

    /// Signs and sends the sales built ahead (each one built again only if it's gone stale). The
    /// quote shown is the estimate; the program still enforces each sale's minimum.
    private func sell(_ quotes: [ForkBuild]) async {
        defer { working = false }
        error = nil
        let marks = TradeMarks()
        do {
            guard let prebuilds else { throw SocialAPIError.invalid("fork_unavailable") }
            var built: [ForkPrepared] = []
            for position in positions {
                let (made, _) = try await prebuilds.take(position)
                marks.mark("built", at: made.madeAt)
                built.append(made)
            }
            let ids = try await app.commitExit(take, positions: positions, built: built, marks: marks)
            marks.mark("shown")
            Self.log.info("sale shown: \(marks.values.description, privacy: .public)")
            await showSold(ids)
        } catch {
            // Whatever sold stays sold; the receipt shows what's left to sell.
            self.quotes = nil
            self.error = Self.friendly(error)
        }
    }

    /// "Sold · Confirming on-chain…" until the sales land (or a moment passes), then the sheet
    /// closes. A sale that doesn't land while it's open is said here; later, the banner does.
    private func showSold(_ ids: [String]) async {
        ids.forEach { app.sheetShows($0, true) }
        confirming = ids
        let until = Date.now.addingTimeInterval(1.5)
        func ended(_ id: String) -> Bool { app.pendingTrades[id].map { $0.status != .confirming } ?? true }
        while Date.now < until, !ids.allSatisfy(ended) {
            try? await Task.sleep(for: .milliseconds(100))
        }
        let failed = ids.compactMap { id -> String? in
            switch app.pendingTrades[id]?.status {
            case .failed(let message)?, .incomplete(let message)?: message
            default: nil
            }
        }
        ids.forEach { app.sheetShows($0, false) }
        confirming = []
        if let message = failed.first {
            quotes = nil // build again before another try
            error = message
        } else {
            dismiss()
        }
    }
}
