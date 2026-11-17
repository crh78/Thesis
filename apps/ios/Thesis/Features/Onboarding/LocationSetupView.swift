import SwiftUI

/// Onboarding step 2: where the user lives. Decides which investments they can
/// be offered (several are unavailable in the US or in some US states).
struct LocationSetupView: View {
    var save: (_ country: String, _ usState: String?) async throws -> Void

    @State private var country = Regions.defaultCountry
    @State private var usState: String?
    @State private var picking: Picking?
    @State private var busy = false
    @State private var error: String?

    private enum Picking: String, Identifiable {
        case country, state
        var id: String { rawValue }
    }

    private var canContinue: Bool { (country != "US" || usState != nil) && !busy }

    var body: some View {
        OnboardingScaffold(title: "Where do you live?",
                           subtitle: "What you can invest in depends on where you live. We'll only show you what's available to you.") {
            VStack(spacing: 0) {
                Hairline()
                row("Country", value: Regions.countryName(country)) { picking = .country }
                if country == "US" {
                    Hairline()
                    row("State", value: usState.map(Regions.stateName) ?? "Choose") { picking = .state }
                }
                Hairline()
                InlineError(text: error).padding(.top, 14)
            }
        } footer: {
            OnboardingButton(title: "Continue", busy: busy, action: submit)
                .disabled(!canContinue)
                .opacity(canContinue ? 1 : 0.5)
        }
        .animation(.snappy, value: country)
        .sheet(item: $picking) { kind in
            RegionPicker(
                title: kind == .country ? "Country" : "State",
                regions: kind == .country ? Regions.countries : Regions.usStates,
                selected: kind == .country ? country : usState
            ) { code in
                if kind == .country {
                    if code != country { usState = nil }
                    country = code
                } else {
                    usState = code
                }
                picking = nil
            }
        }
        .navigationBarBackButtonHidden()
    }

    private func row(_ label: String, value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(label).font(.geist(16)).foregroundStyle(Palette.muted)
                Spacer()
                Text(value).font(.geist(16, .semibold)).foregroundStyle(Palette.text)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.muted)
            }
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label), \(value)")
        .accessibilityIdentifier("\(label.lowercased())-row")
    }

    private func submit() {
        guard canContinue else { return }
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await save(country, country == "US" ? usState : nil)
            } catch {
                self.error = AuthErrorText.message(for: error)
            }
        }
    }
}

/// Searchable list of countries or states.
private struct RegionPicker: View {
    let title: String
    let regions: [Region]
    let selected: String?
    let pick: (String) -> Void

    @State private var query = ""
    @Environment(\.dismiss) private var dismiss

    private var filtered: [Region] {
        query.isEmpty ? regions : regions.filter { $0.name.localizedStandardContains(query) || $0.code == query.uppercased() }
    }

    var body: some View {
        NavigationStack {
            List(filtered) { region in
                Button {
                    pick(region.code)
                } label: {
                    HStack {
                        Text(region.name).font(.geist(16)).foregroundStyle(Palette.text)
                        Spacer()
                        if region.code == selected {
                            Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold))
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.clear)
                .accessibilityAddTraits(region.code == selected ? .isSelected : [])
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(ThesisBackground())
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
    }
}
