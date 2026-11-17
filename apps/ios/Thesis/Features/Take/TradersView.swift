import SwiftUI

/// Who traded and who faded a take. Each person opens their profile.
struct TradersView: View {
    let take: Take
    let traders: [Trader]

    @State private var side: Side = .back
    @Environment(\.dismiss) private var dismiss

    private var shown: [Trader] { traders.filter { $0.side == side } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Picker("Side", selection: $side) {
                        Text("Traded · \(take.backs)").tag(Side.back)
                        Text("Faded · \(take.fades)").tag(Side.fade)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)

                    ForEach(shown) { trader in
                        row(trader)
                        Hairline().padding(.leading, 68)
                    }

                    let unnamed = (side == .back ? take.backs : take.fades) - shown.count
                    if unnamed > 0 {
                        Text(shown.isEmpty ? "\(unnamed) \(side == .back ? "traded" : "faded")" : "+ \(unnamed) more")
                            .font(.geist(13))
                            .foregroundStyle(Palette.muted)
                            .padding(16)
                    }
                }
                .padding(.top, 8)
            }
            .background(ThesisBackground())
            .navigationTitle("Traders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
            .navigationDestination(for: Take.self) { TakeDetailView(take: $0) }
            .peopleDestinations()
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ trader: Trader) -> some View {
        HStack(spacing: 12) {
            PersonLink(person: trader.person) {
                HStack(spacing: 12) {
                    Avatar(name: trader.person.avatar, size: 40)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(trader.isYou ? "You" : trader.person.name).font(.geist(15, .semibold))
                        Text(trader.person.handle).font(.geist(13)).foregroundStyle(Palette.muted)
                    }
                }
            }
            Spacer()
            Text(Fmt.usd(trader.amount))
                .font(.mono(14, .semibold))
                .foregroundStyle(trader.side.text)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}
