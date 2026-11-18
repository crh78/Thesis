import SwiftUI
import ThinkingOrbsKit

/// Copy traders on X: add an account, and each market call it posts becomes a take, basket
/// built, credited to the post. You get a notification for new calls; one tap opens the take to
/// post and buy in. Nothing trades by itself (one-tap copy, not auto-copy).
///
/// One stream, like the feed: the accounts you copy as a row of faces (tap one to see just its
/// calls, hold for more), then every call, newest first.
struct XCopyView: View {
    @Environment(AppState.self) private var app
    @State private var handle = ""
    @State private var adding = false
    @State private var copying: String?
    @State private var error: String?
    @State private var only: String?
    @FocusState private var focused: Bool

    /// Market accounts to start with when you copy nobody yet.
    private let suggestions = ["KobeissiLetter", "unusual_whales", "zerohedge", "WatcherGuru"]

    private var calls: [(account: XAccount, call: XCall)] {
        app.xAccounts
            .filter { only == nil || $0.handle == only }
            .flatMap { a in a.calls.map { (a, $0) } }
            .sorted { $0.call.postedAt > $1.call.postedAt }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                Text("Their market calls become takes. Tap one to build the basket; buying in is up to you.")
                    .font(.geist(14))
                    .foregroundStyle(Palette.muted)
                    .padding(.horizontal, 18)
                    .padding(.bottom, 14)

                accounts

                if adding || app.xAccounts.isEmpty { addRow.transition(.move(edge: .top).combined(with: .opacity)) }

                if let copying {
                    HStack(spacing: 10) {
                        ThinkingOrb(state: .searching, size: .px20)
                        Text("Reading @\(copying)'s recent posts…").font(.geist(14)).foregroundStyle(Palette.muted)
                    }
                    .padding(.horizontal, 18).padding(.vertical, 10)
                    .accessibilityIdentifier("x-copying")
                }
                if let error {
                    Text(error).font(.geist(13)).foregroundStyle(Palette.down)
                        .padding(.horizontal, 18).padding(.vertical, 6)
                        .accessibilityIdentifier("x-copy-error")
                }

                Hairline().padding(.top, 10)

                if app.xAccounts.isEmpty && copying == nil {
                    suggestionsList
                } else if calls.isEmpty {
                    Text(only == nil ? "No market calls yet. You'll hear when they make one."
                                     : "No market calls from them in the last three weeks.")
                        .font(.geist(14)).foregroundStyle(Palette.muted)
                        .frame(maxWidth: .infinity).padding(.vertical, 40)
                }

                ForEach(calls, id: \.call.id) { item in
                    CallRow(account: item.account, call: item.call) {
                        app.openedTake = item.call.link(from: item.account)
                    }
                    Hairline().padding(.leading, 66)
                }
            }
            .padding(.top, 4)
            .padding(.bottom, 32)
            .animation(.snappy, value: adding)
            .animation(.snappy, value: only)
        }
        .scrollDismissesKeyboard(.interactively)
        // One flat color, posts divided by hairlines only: no cards, no glow.
        .background(Palette.bg.ignoresSafeArea())
        .navigationTitle("Copy from X")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await app.refreshXAccounts() }
        .task { await app.refreshXAccounts() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("x-copy")
    }

    // MARK: Accounts

    private var accounts: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 14) {
                Button {
                    adding.toggle()
                    focused = adding
                } label: {
                    VStack(spacing: 6) {
                        Image(systemName: adding ? "xmark" : "plus")
                            .font(.system(size: 18, weight: .semibold))
                            .frame(width: 54, height: 54)
                            .overlay(Circle().strokeBorder(Palette.muted.opacity(0.5), style: StrokeStyle(lineWidth: 1.5, dash: [4, 4])))
                        Text(adding ? "Close" : "Add").font(.geist(12)).foregroundStyle(Palette.muted)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(adding ? "Close" : "Copy an account")
                .accessibilityIdentifier("x-add")

                ForEach(app.xAccounts) { account in
                    let on = only == account.handle
                    Button {
                        only = on ? nil : account.handle
                    } label: {
                        VStack(spacing: 6) {
                            XAvatar(account: account, size: 54)
                                .overlay(Circle().strokeBorder(on ? Palette.up : .clear, lineWidth: 2.5).padding(-4))
                                .opacity(only == nil || on ? 1 : 0.45)
                            Text(account.username).font(.geist(12, on ? .semibold : .regular))
                                .foregroundStyle(on ? Palette.text : Palette.muted)
                                .lineLimit(1).frame(maxWidth: 70)
                        }
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Link(destination: URL(string: "https://x.com/\(account.username)")!) {
                            Label("Open on X", systemImage: "arrow.up.right")
                        }
                        Button("Stop copying", systemImage: "xmark", role: .destructive) {
                            if only == account.handle { only = nil }
                            Task { await app.stopCopyingX(account) }
                        }
                    }
                    .accessibilityLabel("@\(account.username)")
                    .accessibilityHint(on ? "Shows every account" : "Shows only their calls")
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 6)
        }
    }

    private var addRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "at").foregroundStyle(Palette.muted)
            TextField("Handle or profile link", text: $handle)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focused)
                .onSubmit { Task { await copy() } }
                .accessibilityIdentifier("x-handle")
            if !cleanHandle.isEmpty {
                Button("Copy") { Task { await copy() } }
                    .font(.geist(15, .semibold))
                    .foregroundStyle(Palette.up)
                    .disabled(copying != nil)
                    .accessibilityIdentifier("x-copy-button")
            }
        }
        .font(.geist(16))
        .padding(.horizontal, 16)
        .frame(height: 46)
        .background(Palette.tile, in: .capsule)
        .padding(.horizontal, 18)
        .padding(.top, 10)
    }

    private var suggestionsList: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Start with").font(.geist(13, .semibold)).foregroundStyle(Palette.muted)
                .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 4)
            ForEach(suggestions, id: \.self) { s in
                Button {
                    handle = s
                    Task { await copy() }
                } label: {
                    HStack {
                        Text("@\(s)").font(.geist(16, .medium))
                        Spacer()
                        Image(systemName: "plus").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.up)
                    }
                    .padding(.horizontal, 18).frame(height: 50)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Hairline().padding(.leading, 18)
            }
        }
    }

    private var cleanHandle: String {
        var h = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = h.range(of: #"(?:x|twitter)\.com/"#, options: .regularExpression) { h = String(h[r.upperBound...]) }
        h = h.replacingOccurrences(of: "@", with: "")
        return String(h.prefix { $0.isLetter || $0.isNumber || $0 == "_" })
    }

    private func copy() async {
        let h = cleanHandle
        guard !h.isEmpty, copying == nil else { return }
        focused = false
        error = nil
        copying = h
        defer { copying = nil }
        do {
            try await app.copyX(h)
            handle = ""
            adding = false
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// An X account's picture, or its first letter while it loads.
struct XAvatar: View {
    let account: XAccount
    var size: CGFloat

    var body: some View {
        AsyncImage(url: account.avatarUrl) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Text(String(account.username.prefix(1)).uppercased()).font(.geist(size * 0.38, .semibold))
        }
        .frame(width: size, height: size)
        .background(Palette.tile)
        .clipShape(Circle())
    }
}

/// One call in the stream: who, when, the take Thesis drafted, and the post it came from.
private struct CallRow: View {
    let account: XAccount
    let call: XCall
    let onCopy: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            XAvatar(account: account, size: 36)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 4) {
                    Text(account.name ?? account.username).font(.geist(14, .semibold)).lineLimit(1)
                    // "zerohedge @zerohedge" says it twice: the handle only when the name differs.
                    Text(((account.name ?? account.username).caseInsensitiveCompare(account.username) == .orderedSame
                          ? "" : "@\(account.username) · ") + RelativeAge.short(since: call.postedAt))
                        .font(.geist(13)).foregroundStyle(Palette.muted).lineLimit(1)
                }
                Text(call.claim).font(.serif(21)).fixedSize(horizontal: false, vertical: true)
                Text(call.text)
                    .font(.geist(13)).foregroundStyle(Palette.muted).lineLimit(2)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Capsule().fill(Palette.muted.opacity(0.35)).frame(width: 2) }
                HStack {
                    Text(call.risk.map { "\($0.capitalized) risk" } ?? "")
                        .font(.mono(11)).foregroundStyle(Palette.muted)
                    Spacer()
                    Button(action: onCopy) {
                        HStack(spacing: 5) {
                            Text("Copy").font(.geist(14, .semibold))
                            Image(systemName: "arrow.right").font(.system(size: 12, weight: .semibold))
                        }
                        .foregroundStyle(Palette.up)
                        .padding(.vertical, 6).padding(.leading, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy this call")
                    .accessibilityIdentifier("x-call-copy")
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
        .onTapGesture(perform: onCopy)
    }
}
