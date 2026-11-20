import SwiftUI
import ThinkingOrbsKit
import BorderBeamKit

struct TakeDraft: Identifiable, Codable {
    var id = UUID()
    var claim = "AI power demand is underrated."
    var risk: Risk = .medium
    var buyIn: Double = 25
    /// Filled by the take builder (BuildingView); nil means not built yet.
    var legs: [Leg]? = nil
    var summary: String? = nil
    /// The builder found nothing clean to trade.
    var noExposureReason: String? = nil
    /// Started from an asset page: the basket keeps this asset.
    var seed: Asset? = nil
    /// You changed the picks (by asking or by hand): a new risk keeps them instead of rebuilding.
    var edited = false
    /// Where the take came from (a shared article, an X call): posted with it as "via …".
    var source: TakeSource? = nil
    /// What the basket in `legs` was built for (`buildKey` then). Going back and building again
    /// with the same take and risk reuses it, picks you changed included.
    var builtFor: String? = nil
    /// Saved as a draft: when, and whose (the handle), so each account sees its own.
    var savedAt: Date? = nil
    var owner: String? = nil
    /// Backs `inverted`; optional so drafts saved before it still decode. Use `inverted`.
    var bettingAgainst: Bool? = nil

    /// The builder framed the take against its basket ("crypto sucks" over BTC/ETH/SOL): posting
    /// buys in short every pick.
    var inverted: Bool {
        get { bettingAgainst ?? false }
        set { bettingAgainst = newValue }
    }

    var buildKey: String {
        [claim.trimmingCharacters(in: .whitespacesAndNewlines), risk.rawValue, seed?.id ?? ""]
            .joined(separator: "|")
    }
    /// The builder already answered for exactly this take (a basket, or "no clean way to trade this").
    var hasBuild: Bool { builtFor == buildKey && (legs != nil || noExposureReason != nil) }
    /// A basket is ready for exactly this take: Build can go straight to it.
    var isBuilt: Bool { hasBuild && legs != nil && noExposureReason == nil }
}

/// Takes you closed without posting, kept on this phone until you post or delete them.
@Observable
final class DraftStore {
    static let shared = DraftStore()

    private(set) var all: [TakeDraft] = []
    private let key = "thesis.takeDrafts.v1"

    private init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let saved = try? JSONDecoder().decode([TakeDraft].self, from: data) {
            all = saved
        }
    }

    /// An account's drafts, newest first.
    func drafts(for owner: String) -> [TakeDraft] {
        all.filter { $0.owner == owner }.sorted { ($0.savedAt ?? .distantPast) > ($1.savedAt ?? .distantPast) }
    }

    func save(_ draft: TakeDraft, owner: String) {
        var draft = draft
        draft.owner = owner
        draft.savedAt = .now
        all.removeAll { $0.id == draft.id }
        all.append(draft)
        persist()
    }

    func remove(_ id: UUID) {
        guard all.contains(where: { $0.id == id }) else { return }
        all.removeAll { $0.id == id }
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(all) { UserDefaults.standard.set(data, forKey: key) }
    }
}

private enum CreateStep: Hashable { case building, basket }

/// New take: write it → Thesis builds the basket → review and buy in.
struct CreateFlow: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var app
    /// Closing a take you've started asks: save it as a draft, discard it, or keep going.
    @State private var closing = false
    @State private var path: [CreateStep] = []
    @State private var draft = TakeDraft(claim: "")
    /// What you typed in the "What's your take?" bar; copied into the draft
    /// when the flow appears (an @State initial value can be stale here).
    let initialClaim: String
    /// Opened from a chat link (skips the composer, auto-advances to the basket).
    private var fromLink = false
    /// Shared from another app: read the article or post first, then open the composer on the
    /// take Thesis drafted from it.
    @State private var reading: TakeLink.ReadRequest?

    init(initialClaim: String) {
        self.initialClaim = initialClaim
    }

    /// A saved draft, picked up where you left it: on the basket if it was built.
    init(draft: TakeDraft) {
        initialClaim = draft.claim
        _draft = State(initialValue: draft)
        _path = State(initialValue: draft.isBuilt ? [.building, .basket] : [])
    }

    /// "Make a take with this" on an asset page: write the take; the basket keeps the asset.
    init(seed: Asset) {
        initialClaim = ""
        _draft = State(initialValue: TakeDraft(claim: "", seed: seed))
    }

    /// Opened from a chat link: the take and risk are already set, so skip the
    /// composer and start on building → basket.
    init(link: TakeLink) {
        initialClaim = link.claim
        if let read = link.read {
            _reading = State(initialValue: read)
            return
        }
        _draft = State(initialValue: TakeDraft(claim: link.claim, risk: link.risk, source: link.source))
        _path = State(initialValue: [.building])
        fromLink = true
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let reading {
                    ReadingView(request: reading, draft: $draft, onClose: { dismiss() }) { self.reading = nil }
                } else {
                    CreateTakeView(draft: $draft, onClose: requestClose) {
                        // Built already for this exact take (you came back to it): no building again.
                        path.append(.building)
                        if draft.isBuilt { path.append(.basket) }
                    }
                }
            }
                .navigationDestination(for: CreateStep.self) { step in
                    switch step {
                    // Binding, not a copy: this closure can be captured before the
                    // typed take is copied into the draft, which left the card blank.
                    case .building: BuildingView(draft: $draft, autoAdvance: fromLink, onClose: requestClose) { path.append(.basket) }
                    case .basket: BasketView(draft: $draft, onClose: requestClose) {
                        DraftStore.shared.remove(draft.id)
                        dismiss()
                    }
                    }
                }
        }
        .confirmationDialog("Save this take as a draft?", isPresented: $closing, titleVisibility: .visible) {
            Button("Save draft") {
                DraftStore.shared.save(draft, owner: app.me.id)
                dismiss()
            }
            Button("Discard", role: .destructive) {
                DraftStore.shared.remove(draft.id)
                dismiss()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("Drafts wait in My takes on your profile.")
        }
        .onAppear {
            if draft.claim.isEmpty {
                draft.claim = initialClaim.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
    }

    /// Nothing written yet: just close. Otherwise ask what to do with it.
    private func requestClose() {
        if draft.claim.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            dismiss()
        } else {
            closing = true
        }
    }
}

// MARK: - Write the take

struct CreateTakeView: View {
    @Binding var draft: TakeDraft
    let onClose: () -> Void
    let onNext: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Your take").font(.geist(13, .semibold)).foregroundStyle(Palette.muted)
                    TextEditor(text: $draft.claim)
                        .font(.serif(30))
                        .scrollContentBackground(.hidden)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .frame(height: 140)
                        .glassEffect(.regular, in: .rect(cornerRadius: 26))
                    Text("Say it in plain words. Thesis finds investments that match it, or tells you if there's no clean way to bet on it.")
                        .font(.geist(13))
                        .foregroundStyle(Palette.muted)
                    if let seed = draft.seed {
                        HStack(spacing: 8) {
                            Image(systemName: "pin.fill").font(.system(size: 12)).foregroundStyle(Palette.up)
                            Text("Your basket starts with \(seed.name)").font(.geist(13, .medium))
                            Spacer()
                            Button { draft.seed = nil } label: { Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)) }
                                .accessibilityLabel("Don't start with \(seed.name)")
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(Palette.tile, in: .capsule)
                        .accessibilityIdentifier("composer-seed")
                    }
                    if let source = draft.source {
                        HStack(spacing: 8) {
                            SourceMark(source: source)
                            Spacer()
                            Button { draft.source = nil } label: { Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)) }
                                .accessibilityLabel("Don't credit \(source.label)")
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(Palette.tile, in: .capsule)
                        .accessibilityIdentifier("composer-source")
                    }
                }

                HStack(spacing: 10) {
                    ThinkingOrb(state: .composing, size: .px20)
                    Text("Thesis").font(.geist(14, .semibold))
                    Text("· one quick question").font(.geist(14)).foregroundStyle(Palette.muted)
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("How much risk?").font(.geist(17, .semibold))
                    GlassEffectContainer(spacing: 8) {
                        HStack(spacing: 8) {
                            ForEach(Risk.allCases) { risk in
                                let on = draft.risk == risk
                                Button { withAnimation(.snappy) { draft.risk = risk } } label: {
                                    VStack(spacing: 3) {
                                        Text(risk.rawValue).font(.geist(15, .semibold))
                                        Text(risk.note).font(.geist(12)).foregroundStyle(Palette.muted)
                                    }
                                    .foregroundStyle(Palette.text)
                                    .frame(maxWidth: .infinity, minHeight: 72)
                                    .contentShape(.rect(cornerRadius: 22))
                                }
                                .buttonStyle(.plain)
                                .glassEffect(on ? .regular.tint(Palette.text.opacity(0.2)).interactive() : .regular.interactive(),
                                             in: .rect(cornerRadius: 22))
                                .accessibilityAddTraits(on ? .isSelected : [])
                            }
                        }
                    }
                    // No horizon to pick: the take runs until you sell your buy-in, a year at most.
                    Text(TakeLifetime.note)
                        .font(.geist(13))
                        .foregroundStyle(Palette.muted)
                        .accessibilityIdentifier("take-lifetime")
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(ThesisBackground())
        .navigationTitle("New take")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: onClose) { Image(systemName: "xmark") }
                    .accessibilityLabel("Close")
            }
        }
        .safeAreaBar(edge: .bottom) {
            PrimaryGlassButton(title: "Build my basket", systemImage: "arrow.right", action: onNext)
                .disabled(draft.claim.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
        }
    }
}

// MARK: - Reading what you shared

/// Shared from another app: reads the article or X post and drafts the take, then hands over to
/// the composer with it filled in, to edit before building the basket.
struct ReadingView: View {
    let request: TakeLink.ReadRequest
    @Binding var draft: TakeDraft
    let onClose: () -> Void
    let onDone: () -> Void

    @Environment(AppState.self) private var app

    private var isX: Bool {
        let host = request.url.host()?.lowercased() ?? ""
        return host == "x.com" || host.hasSuffix(".x.com") || host.hasSuffix("twitter.com")
    }

    var body: some View {
        VStack(spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text(isX ? "Post on X" : (request.url.host()?.replacingOccurrences(of: "www.", with: "") ?? "Link"))
                    .font(.geist(12, .semibold)).foregroundStyle(Palette.muted)
                Text(request.title ?? request.url.absoluteString)
                    .font(.serif(22)).lineLimit(4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .glassEffect(.regular, in: .rect(cornerRadius: 28))
            .borderBeam(.md, colorVariant: .colorful, theme: .auto, active: true, borderRadius: 28, strength: 0.8)
            .padding(.horizontal, 16)
            .padding(.top, 12)

            ThesisLoader(lines: [isX ? "Reading the post" : "Reading the article", "Finding the market view", "Writing your take"],
                         state: .searching, fullScreen: false)
                .frame(maxHeight: .infinity)
        }
        .background(ThesisBackground())
        .navigationTitle("New take")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: onClose) { Image(systemName: "xmark") }
                    .accessibilityLabel("Close")
            }
        }
        .task {
            draft = await app.draftTake(from: request, keeping: draft)
            onDone()
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("reading")
    }
}

/// "via Reuters", "via @KobeissiLetter on X".
struct SourceMark: View {
    let source: TakeSource

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: source.isX ? "at" : "link").font(.system(size: 11, weight: .semibold))
                .accessibilityHidden(true)
            Text("via \(source.label)").font(.geist(13, .medium)).lineLimit(1)
        }
        .foregroundStyle(Palette.muted)
    }
}

// MARK: - Thesis is building the basket

struct BuildingView: View {
    @Binding var draft: TakeDraft
    /// Opened from a chat link: go on to the basket by itself once it's built.
    var autoAdvance = false
    var onClose: () -> Void = {}
    let onNext: () -> Void

    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var step = 0
    @State private var built = false
    @State private var buildError: String?

    private let phases: [(title: String, sub: String, orb: OrbState)] = [
        ("Reading your take", "Working out what has to be true for you to be right.", .working),
        ("Searching for matches", "Assets tied to your idea.", .searching),
        ("Checking the fit", "How closely each pick tracks your take, and how easy it is to buy.", .solving)
    ]
    private let labels = ["Reading your take", "Finding assets that match", "Checking how closely each one fits"]

    private var done: Bool { step >= phases.count && built }
    private var noExposure: String? { draft.noExposureReason }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Your take").font(.geist(12, .semibold)).foregroundStyle(Palette.muted)
                    Text(draft.claim).font(.serif(26)).fixedSize(horizontal: false, vertical: true)
                    Text("\(draft.risk.rawValue) risk").font(.geist(13)).foregroundStyle(Palette.muted)
                    if let source = draft.source { SourceMark(source: source).padding(.top, 2) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(18)
                .glassEffect(.regular, in: .rect(cornerRadius: 28))
                .borderBeam(.md, colorVariant: .colorful, theme: .auto, active: !done, borderRadius: 28, strength: 0.8)
                .padding(.horizontal, 16)
                .padding(.top, 12)

                VStack(spacing: 16) {
                    ThinkingOrb(state: done || buildError != nil ? .breathing : phases[min(step, phases.count - 1)].orb,
                                size: .px64, paused: done || buildError != nil)
                    Text(buildError != nil ? "Couldn't build your basket"
                         : done ? (noExposure != nil ? "No clean way to trade this" : "Your basket is ready")
                         : phases[min(step, phases.count - 1)].title)
                        .font(.geist(20, .semibold))
                        .contentTransition(.opacity)
                    Text(buildError ?? (done ? (noExposure ?? "\(draft.legs?.count ?? 0) picks · \(draft.risk.rawValue) risk")
                                         : phases[min(step, phases.count - 1)].sub))
                        .font(.geist(14))
                        .foregroundStyle(Palette.muted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 290)
                }
                .padding(.top, 44)
                .accessibilityElement(children: .combine)

                VStack(spacing: 0) {
                    ForEach(labels.indices, id: \.self) { i in
                        if i > 0 { Hairline() }
                        HStack(spacing: 12) {
                            stepIcon(i)
                            Text(labels[i])
                                .font(.geist(15, .semibold))
                                .foregroundStyle(!done && i > step ? Palette.muted : Palette.text)
                            Spacer()
                        }
                        .frame(minHeight: 54)
                    }
                }
                .padding(.horizontal, 22)
                .padding(.top, 32)
            }
        }
        .background(ThesisBackground())
        .navigationTitle("New take")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: onClose) { Image(systemName: "xmark") }
                    .accessibilityLabel("Close")
            }
        }
        .task { await build() }
        .safeAreaBar(edge: .bottom) {
            // No skipping: the basket isn't ready until it's built.
            Group {
                if buildError != nil {
                    PrimaryGlassButton(title: "Try again", systemImage: "arrow.clockwise") { Task { await build() } }
                } else if done && noExposure != nil {
                    PrimaryGlassButton(title: "Edit your take", systemImage: "pencil") { dismiss() }
                } else {
                    PrimaryGlassButton(title: done ? "See your basket" : "Building your basket…",
                                       systemImage: done ? "arrow.right" : nil, action: onNext)
                        .disabled(!done)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
    }

    private func attempt(_ draft: TakeDraft) async -> Result<BuiltBasket, Error> {
        do { return .success(try await app.buildBasket(for: draft)) } catch { return .failure(error) }
    }

    /// Builds the basket while the steps animate; the steps finish when it's back.
    private func build() async {
        buildError = nil
        // Built already for this exact take: show it instead of building again.
        if draft.hasBuild {
            built = true
            step = phases.count
            return
        }
        built = false
        step = 0
        let draftNow = draft
        async let result = attempt(draftNow)
        for _ in 0..<(phases.count - 1) {
            try? await Task.sleep(for: .milliseconds(450))
            withAnimation(.smooth) { step += 1 }
        }
        switch await result {
        case .success(let basket):
            draft.legs = basket.legs
            draft.summary = basket.summary
            draft.noExposureReason = basket.noExposureReason
            draft.inverted = basket.inverted
            draft.builtFor = draftNow.buildKey
            withAnimation(.smooth) {
                built = true
                step = phases.count
            }
            if autoAdvance && basket.noExposureReason == nil {
                try? await Task.sleep(for: .milliseconds(600))
                if !Task.isCancelled { onNext() }
            }
        case .failure(let error):
            buildError = (error as? LocalizedError)?.errorDescription ?? "Check your connection and try again."
        }
    }

    @ViewBuilder private func stepIcon(_ i: Int) -> some View {
        if done || i < step {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 22))
                .foregroundStyle(Palette.up)
        } else if i == step {
            ThinkingOrb(state: .working, size: .px20)
                .frame(width: 22, height: 22)
        } else {
            Circle().strokeBorder(Palette.hairline, lineWidth: 2).frame(width: 22, height: 22)
        }
    }
}

// MARK: - Review the basket

struct BasketView: View {
    @Binding var draft: TakeDraft
    var onClose: () -> Void = {}
    /// Called once the take is posted.
    let onPost: () -> Void

    @Environment(AppState.self) private var app
    @State private var selected: Leg.ID?
    @State private var posting = false
    @State private var postError: String?
    @State private var rebuilding = false
    @State private var rebuildNote: String?
    @State private var ask = ""
    @State private var adding = false
    @State private var weighing: Leg?
    @State private var about: Leg?
    /// The fork can't buy every leg right now: asked before signing (see `post()`).
    @State private var leftOutAsk: LeftOutAsk?
    @FocusState private var askFocused: Bool

    struct LeftOutAsk {
        let legs: [ForkBuild.LeftOut]
        let answer: CheckedContinuation<Bool, Never>
    }

    /// The built basket (offline: the mock one for the current risk until you change it).
    private var legs: [Leg] { draft.legs ?? MockData.basket(for: draft.risk) }
    /// Nothing about the basket changes while it's being rebuilt or bought: once you tap Buy in,
    /// the basket you see is the one that's posted.
    private var locked: Bool { rebuilding || posting }
    private var picked: Leg? { legs.first { $0.id == selected } }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                VStack(spacing: 4) {
                    Text(draft.claim).font(.serif(24)).multilineTextAlignment(.center)
                    Text(TakeLifetime.note).font(.geist(13)).foregroundStyle(Palette.muted)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("take-lifetime")
                    if let source = draft.source { SourceMark(source: source) }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)

                ZStack {
                    BasketDonut(legs: legs, selected: selected)
                        .frame(width: 210, height: 210)
                        .opacity(rebuilding ? 0.35 : 1)
                    if rebuilding { ProgressView().controlSize(.large) }
                    VStack(spacing: 2) {
                        Text(picked.map { "\(Int($0.weight))%" } ?? "\(legs.count)")
                            .font(.geist(36, .bold))
                            .contentTransition(.numericText())
                        Text(picked?.name ?? "picks · tap one to see it")
                            .font(.geist(12))
                            .foregroundStyle(Palette.muted)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 110)
                    }
                }
                .padding(.top, 18)

                if draft.inverted {
                    // The take is against these picks: posting shorts every one.
                    VStack(spacing: 6) {
                        AgainstBadge(title: "Betting against")
                        Text("You're short these. Your take gains when they fall.")
                            .font(.geist(13))
                            .foregroundStyle(Palette.text)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 14)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("basket-against")
                }

                Picker("Risk", selection: $draft.risk) {
                    ForEach(Risk.allCases) { Text("\($0.rawValue) risk").tag($0) }
                }
                .pickerStyle(.segmented)
                .disabled(locked)
                .padding(.horizontal, 16)
                .padding(.top, 18)

                Text(rebuildNote ?? draft.summary ?? draft.risk.basketNote)
                    .font(.geist(13))
                    .foregroundStyle(rebuildNote != nil ? Palette.text : Palette.muted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                    .padding(.top, 8)
                    .accessibilityIdentifier("basket-note")

                changeField
                    .disabled(locked)
                    .opacity(posting ? 0.45 : 1)
                    .padding(.horizontal, 16)
                    .padding(.top, 14)

                VStack(spacing: 2) {
                    ForEach(legs) { leg in
                        HStack(spacing: 0) {
                            Button {
                                withAnimation(.snappy) { selected = selected == leg.id ? nil : leg.id }
                            } label: {
                                LegExplainRow(leg: leg, short: draft.inverted)
                                    .contentShape(.rect(cornerRadius: 20))
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(selected == leg.id ? .isSelected : [])
                            pickMenu(leg)
                        }
                        .background(selected == leg.id ? Palette.tile : .clear, in: .rect(cornerRadius: 20))
                    }
                    if legs.count < BasketMath.maxPicks {
                        Button { adding = true } label: {
                            Label("Add a pick", systemImage: "plus")
                                .font(.geist(15, .semibold))
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Palette.up)
                        .disabled(locked)
                        .opacity(posting ? 0.45 : 1)
                        .accessibilityIdentifier("basket-add-pick")
                    }
                }
                .padding(.horizontal, 6)
                .padding(.top, 10)
                .padding(.bottom, 16)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .background(ThesisBackground())
        .navigationTitle("Your basket")
        .navigationBarTitleDisplayMode(.inline)
        // Going back mid-post could change the take after its buy-in was sent.
        .navigationBarBackButtonHidden(posting)
        .toolbar {
            if !posting {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: onClose) { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
            }
        }
        .interactiveDismissDisabled(posting)
        .onChange(of: draft.risk) {
            selected = nil
            Task { await riskChanged() }
        }
        .sheet(isPresented: $adding) {
            AssetPickerView(legs: legs, shortOnly: draft.inverted) { asset in change(BasketMath.adding(asset, to: legs)) }
        }
        .alert(
            leftOutAsk.map { $0.legs.count == 1 ? "1 pick can't be bought right now" : "\($0.legs.count) picks can't be bought right now" } ?? "",
            isPresented: Binding(get: { leftOutAsk != nil }, set: { _ in })
        ) {
            Button("Post without them") { answerLeftOut(true) }
            Button("Don't post", role: .cancel) { answerLeftOut(false) }
        } message: {
            Text((leftOutAsk?.legs ?? []).map { "\($0.name): \($0.reason)" }.joined(separator: "\n")
                 + "\n\nYour buy-in only buys the rest, and the take is locked once it's live.")
        }
        .sheet(item: $weighing) { leg in
            WeightSheet(leg: leg, picks: legs.count) { change(BasketMath.setting(leg, to: $0, in: legs)) }
                .presentationDetents([.height(260)])
        }
        .sheet(item: $about) { leg in
            NavigationStack {
                AssetView(assetID: leg.assetID ?? "", canStartTake: false)
                    .navigationDestination(for: Take.self) { TakeDetailView(take: $0) }
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { about = nil } } }
            }
        }
        .safeAreaBar(edge: .bottom) {
            // Hidden while you type a change, so a tap meant for the field can't post the take.
            if !askFocused {
            VStack(alignment: .leading, spacing: 8) {
                if let postError {
                    Label(postError, systemImage: "exclamationmark.circle")
                        .font(.geist(13, .medium))
                        .foregroundStyle(Palette.down)
                        .padding(.horizontal, 6)
                } else {
                    // In the bar, not at the end of the list: there it showed through the glass
                    // buttons whenever the basket was long.
                    Text(draft.inverted
                         ? "You buy in betting these fall. Once it's live, the take is locked for good."
                         : "You buy in to post. Once it's live, the take is locked for good.")
                        .font(.geist(12))
                        .foregroundStyle(Palette.muted)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                }
                GlassEffectContainer(spacing: 8) {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 0) {
                            Text("Buy-in").font(.geist(11)).foregroundStyle(Palette.muted)
                            TextField("Buy-in", value: $draft.buyIn, format: .currency(code: "USD").precision(.fractionLength(0...2)))
                                .font(.geist(18, .bold))
                                .keyboardType(.decimalPad)
                                .disabled(posting)
                        }
                        .padding(.horizontal, 18)
                        .frame(width: 118, height: 56)
                        .glassEffect(.regular, in: .capsule)

                        PrimaryGlassButton(title: posting ? "Posting…" : "Buy in & post", action: post)
                            .disabled(posting || rebuilding)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            }
        }
    }

    /// "Change something…": ask for an edit in plain words.
    private var changeField: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles").font(.system(size: 14)).foregroundStyle(Palette.muted)
            TextField("Change something… (add AMD, less crypto)", text: $ask)
                .font(.geist(15))
                .focused($askFocused)
                .submitLabel(.send)
                .onSubmit { Task { await sendAsk() } }
                .accessibilityIdentifier("basket-change-field")
            if !ask.trimmingCharacters(in: .whitespaces).isEmpty {
                Button { Task { await sendAsk() } } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 26))
                }
                .foregroundStyle(Palette.up)
                .disabled(rebuilding)
                .accessibilityLabel("Change the basket")
                .accessibilityIdentifier("basket-change-send")
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .frame(minHeight: 46)
        .glassEffect(.regular, in: .capsule)
    }

    private func pickMenu(_ leg: Leg) -> some View {
        Menu {
            if leg.assetID != nil {
                Button("About \(leg.name)", systemImage: "info.circle") { about = leg }
            }
            Button("Set weight", systemImage: "slider.horizontal.3") { weighing = leg }
                .disabled(legs.count < 2)
            Button("Remove", systemImage: "minus.circle", role: .destructive) {
                if selected == leg.id { selected = nil }
                change(BasketMath.removing(leg, from: legs))
            }
            .disabled(legs.count < 2)
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.muted)
                .frame(width: 40, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("More for \(leg.name)")
        .disabled(locked)
    }
}

extension BasketView {
    /// A hand edit: new picks, from now on kept across risk changes.
    private func change(_ next: [Leg]) {
        rebuildNote = nil
        withAnimation(.snappy) {
            draft.legs = next
            draft.edited = true
        }
    }

    private func sendAsk() async {
        let text = ask.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !locked else { return }
        askFocused = false
        rebuilding = true
        rebuildNote = nil
        defer { rebuilding = false }
        do {
            let basket = try await app.editBasket(draft, legs: legs, ask: text)
            withAnimation(.snappy) {
                if basket.legs != legs {
                    draft.legs = basket.legs
                    draft.edited = true
                    selected = nil
                }
                draft.inverted = basket.inverted
                if let summary = basket.summary { draft.summary = summary }
            }
            rebuildNote = basket.note
            if basket.note == nil { ask = "" }
        } catch {
            rebuildNote = "Couldn't change the basket. Try again."
        }
    }

    /// Risk changed. Picks you changed stay (only the cash / leveraged pick moves); otherwise build again
    /// for the new risk (low adds cash yield, high adds leverage).
    private func riskChanged() async {
        if !draft.edited && !app.isLive {
            withAnimation(.snappy) { draft.legs = MockData.basket(for: draft.risk) }
            draft.builtFor = draft.buildKey
            return
        }
        rebuilding = true
        rebuildNote = nil
        defer { rebuilding = false }
        do {
            let basket = draft.edited ? try await app.adjustRisk(draft, legs: legs) : try await app.buildBasket(for: draft)
            if let reason = basket.noExposureReason {
                rebuildNote = reason
            } else if !basket.legs.isEmpty {
                withAnimation(.snappy) {
                    draft.legs = basket.legs
                    draft.inverted = basket.inverted
                    if let summary = basket.summary { draft.summary = summary }
                }
                draft.builtFor = draft.buildKey
            }
        } catch {
            rebuildNote = "Couldn't rebuild for \(draft.risk.rawValue.lowercased()) risk. Try again."
        }
    }

    /// Posts the take; stays on this screen with the error if it fails.
    private func post() {
        guard !locked else { return }
        askFocused = false
        posting = true
        postError = nil
        Task {
            do {
                try await app.post(draft, legs: legs, confirmLeftOut: { left in
                    await withCheckedContinuation { leftOutAsk = LeftOutAsk(legs: left, answer: $0) }
                })
                onPost()
            } catch let e as ForkAPIError where e.code == "post_cancelled" {
                // You chose not to post with picks left out: stay on the basket to change it.
            } catch {
                postError = (error as? LocalizedError)?.errorDescription ?? "Couldn't post your take. Try again."
            }
            posting = false
        }
    }

    private func answerLeftOut(_ post: Bool) {
        guard let ask = leftOutAsk else { return }
        leftOutAsk = nil
        ask.answer.resume(returning: post)
    }
}

/// "Set weight": one pick's share of the basket; the others share the rest.
private struct WeightSheet: View {
    let leg: Leg
    let picks: Int
    let onDone: (Double) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var weight: Double = 0

    var body: some View {
        VStack(spacing: 14) {
            Text(leg.name).font(.geist(15, .semibold)).padding(.top, 22)
            Text("\(Int(weight))%").font(.geist(44, .bold)).contentTransition(.numericText())
                .accessibilityIdentifier("weight-value")
            Slider(value: $weight, in: 1...Double(100 - (picks - 1)), step: 1)
                .tint(Palette.up)
                .accessibilityIdentifier("weight-slider")
            Text("The other picks share the rest.").font(.geist(13)).foregroundStyle(Palette.muted)
            PrimaryGlassButton(title: "Done") {
                onDone(weight)
                dismiss()
            }
            .accessibilityIdentifier("weight-done")
        }
        .padding(.horizontal, 20)
        .onAppear { weight = leg.weight }
    }
}

private struct LegExplainRow: View {
    let leg: Leg
    /// The take bets against its picks: this one is held short (a prediction: its other side).
    var short = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AssetLogo(key: leg.assetKey, name: leg.name, kind: leg.kind, size: 34, ring: Palette.series(leg.slot))
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(Int(leg.weight))%").font(.mono(14, .semibold)).frame(width: 40, alignment: .leading)
                    Text(leg.name).font(.geist(15, .semibold))
                    Spacer(minLength: 4)
                    if short {
                        Text(leg.predictionSide != nil ? leg.fadeHow ?? "Short" : "Short")
                            .font(.geist(12, .semibold))
                            .foregroundStyle(Palette.down)
                            .accessibilityIdentifier("leg-short")
                    }
                    Text(leg.kind).font(.geist(12)).foregroundStyle(Palette.muted)
                }
                Text(leg.why)
                    .font(.geist(13))
                    .foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 48)
            }
        }
        .foregroundStyle(Palette.text)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}
