import SwiftUI

/// Fork mode, your own profile only: what you earned as a creator (5 bps of every back and fade
/// of your takes by someone else), what you've claimed, and Claim per take or Claim all. Amounts are
/// exact: creator shares are often fractions of a cent.
struct CreatorFeesSection: View {
    @Environment(AppState.self) private var app
    let fees: ForkCreatorFees
    /// The take being claimed, or "all".
    @State private var claiming: String?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Creator fees").font(.geist(15, .semibold))
                    Text("\(Self.exact(fees.earnedUsd)) earned · \(Self.exact(fees.claimedUsd)) claimed")
                        .font(.geist(12))
                        .foregroundStyle(Palette.muted)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Self.exact(fees.unclaimedUsd)).font(.mono(15, .semibold))
                    Text("to claim").font(.geist(11)).foregroundStyle(Palette.muted)
                }
            }
            .accessibilityElement(children: .combine)

            if fees.unclaimedUsd > 0 {
                Button(claiming == "all" ? "Claiming…" : "Claim all") { claim(nil) }
                    .font(.geist(14, .semibold))
                    .frame(maxWidth: .infinity)
                    .buttonStyle(.glass)
                    .disabled(claiming != nil)
                    .accessibilityIdentifier("creator-fees-claim-all")
            }

            ForEach(fees.takes) { take in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(take.claim ?? "Take \(take.take.prefix(4))…\(take.take.suffix(4))")
                            .font(.serif(15))
                            .lineLimit(1)
                        Text("\(Self.exact(take.earnedUsd)) earned · \(Self.exact(take.claimedUsd)) claimed")
                            .font(.geist(11))
                            .foregroundStyle(Palette.muted)
                    }
                    Spacer(minLength: 6)
                    if take.unclaimedUsd > 0 {
                        Button(claiming == take.take ? "Claiming…" : "Claim \(Self.exact(take.unclaimedUsd))") { claim(take.take) }
                            .font(.geist(13, .semibold))
                            .buttonStyle(.glass)
                            .disabled(claiming != nil)
                    } else {
                        Text("Claimed").font(.geist(12)).foregroundStyle(Palette.muted)
                    }
                }
                .frame(minHeight: 44)
            }

            if let error {
                Text(error).font(.geist(12)).foregroundStyle(Palette.down)
            }
        }
        .accessibilityIdentifier("creator-fees")
    }

    private func claim(_ take: String?) {
        claiming = take ?? "all"
        error = nil
        Task {
            do {
                try await app.claimCreatorFees(take: take)
            } catch {
                // A batch that failed part-way has claimed what landed; the refreshed amounts show it.
                await app.refreshCreatorFees()
                self.error = (error as? LocalizedError)?.errorDescription ?? "Couldn't claim. Try again."
            }
            claiming = nil
        }
    }

    /// Dollars to the micro-dollar, trailing zeros dropped after the cents: $0.05, $0.005, $12.50.
    static func exact(_ usd: Double) -> String {
        usd.formatted(.currency(code: "USD").precision(.fractionLength(2...6)))
    }
}
