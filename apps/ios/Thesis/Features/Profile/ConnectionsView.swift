import SwiftUI

/// Followers / Following, X-style: yours (from the sidebar) or anyone's (from
/// their profile). Someone else's list can be private; then it says so.
struct ConnectionsView: View {
    @Environment(AppState.self) private var app
    @State private var tab: ConnectionsTab
    /// nil: yours.
    private let owner: Person?
    @State private var lists: [ConnectionsTab: PeopleList] = [:]
    @State private var removing: Person?

    init(owner: Person? = nil, initialTab: ConnectionsTab) {
        self.owner = owner
        _tab = State(initialValue: initialTab)
    }

    private var isMine: Bool { owner.map(app.isMe) ?? true }

    private var list: PeopleList? {
        guard isMine else { return lists[tab] }
        return .people(tab == .followers ? app.followers : app.followingPeople)
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                UnderlineTabs(items: ConnectionsTab.allCases.map { ($0, $0.rawValue) }, selection: $tab, equalWidth: true)
                Hairline()
                if isMine && !app.privacy.shows(tab) {
                    privateNote
                }
                switch list {
                case .people(let people):
                    ForEach(people) { person in
                        PersonRow(person: person, followsYou: followsYou(person),
                                  onRemove: isMine && tab == .followers ? { removing = person } : nil)
                        Hairline()
                    }
                    if people.isEmpty { empty.padding(.top, 40) }
                case .hidden:
                    let name = owner?.name ?? "They"
                    ContentUnavailableView("\(name) keeps this private", systemImage: "lock",
                                           description: Text(tab == .following
                                                             ? "Only \(name) can see who they follow."
                                                             : "Only \(name) can see who follows them."))
                        .padding(.top, 40)
                case .failed(let message):
                    ContentUnavailableView("Couldn't load", systemImage: "exclamationmark.triangle",
                                           description: Text(message))
                        .padding(.top, 40)
                case nil:
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
        }
        .background(ThesisBackground())
        .navigationTitle(owner?.name ?? app.me.name)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: tab) { await loadIfNeeded() }
        .refreshable {
            if isMine { await app.refresh() } else { await load() }
        }
        .confirmationDialog("Remove \(removing?.name ?? "")?", isPresented: removingBinding, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                if let person = removing { withAnimation(.snappy) { app.removeFollower(person) } }
                removing = nil
            }
            Button("Cancel", role: .cancel) { removing = nil }
        } message: {
            Text("They won't be told, and they can follow you again.")
        }
    }

    /// Your list is hidden from others: say so, with a way to change it.
    private var privateNote: some View {
        Button { app.open(.settings) } label: {
            HStack(spacing: 8) {
                Image(systemName: "lock.fill")
                Text("Only you can see this list")
                Spacer()
                Text("Change").fontWeight(.semibold)
            }
            .font(.geist(13))
            .foregroundStyle(Palette.muted)
            .padding(.horizontal, 16)
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var empty: some View {
        let name = isMine ? nil : owner?.name
        if tab == .following {
            ContentUnavailableView(name.map { "\($0) isn't following anyone" } ?? "Not following anyone yet",
                                   systemImage: "person.2",
                                   description: Text(name == nil ? "Follow callers to see their takes in your feed." : ""))
        } else {
            ContentUnavailableView(name.map { "\($0) has no followers yet" } ?? "No followers yet",
                                   systemImage: "person.2",
                                   description: Text(name == nil ? "Post a take and people will find you." : ""))
        }
    }

    private var removingBinding: Binding<Bool> {
        Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
    }

    private func loadIfNeeded() async {
        guard !isMine, lists[tab] == nil else { return }
        await load()
    }

    private func load() async {
        guard let owner, !isMine else { return }
        let result = await app.peopleList(of: owner, tab)
        withAnimation(.snappy) { lists[tab] = result }
    }
}

extension ConnectionsView {
    private func followsYou(_ person: Person) -> Bool {
        app.isLive ? person.followsYou : MockData.followers.contains { $0.id == person.id }
    }
}

struct PersonRow: View {
    @Environment(AppState.self) private var app
    let person: Person
    var followsYou = false
    /// Set on your Followers list: adds a "Remove this follower" menu.
    var onRemove: (() -> Void)? = nil

    var body: some View {
        let following = app.isFollowing(person)

        HStack(alignment: .top, spacing: 12) {
            PersonLink(person: person) { Avatar(name: person.avatar, size: 44) }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .top) {
                    PersonLink(person: person) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(person.name).font(.geist(15, .semibold))
                        HStack(spacing: 6) {
                            Text(person.handle).font(.geist(14)).foregroundStyle(Palette.muted)
                            if followsYou {
                                Text("Follows you")
                                    .font(.geist(11, .medium))
                                    .foregroundStyle(Palette.muted)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Palette.tile, in: .rect(cornerRadius: 5))
                            }
                        }
                    }
                    }
                    Spacer()
                    if let onRemove {
                        Menu {
                            Button("Remove this follower", systemImage: "person.badge.minus", role: .destructive, action: onRemove)
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(Palette.muted)
                                .frame(width: 32, height: 36)
                                .contentShape(Rectangle())
                        }
                        .accessibilityLabel("More for \(person.name)")
                    }
                    if !app.isMe(person) {
                    Button { withAnimation(.snappy) { app.toggleFollow(person) } } label: {
                        Text(following ? "Following" : "Follow")
                            .font(.geist(14, .semibold))
                            .foregroundStyle(following ? Palette.text : Palette.bg)
                            .padding(.horizontal, 16)
                            .frame(minHeight: 36)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .glassEffect(following ? .regular.interactive() : .regular.tint(Palette.text).interactive(), in: .capsule)
                    .accessibilityLabel(following ? "Unfollow \(person.name)" : "Follow \(person.name)")
                    }
                }
                if !person.bio.isEmpty {
                    Text(person.bio).font(.geist(14)).fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 4) {
                    Text(Fmt.usd(person.made, signed: true)).foregroundStyle(person.made >= 0 ? Palette.up : Palette.down)
                    Text("made · \(person.takes) \(person.takes == 1 ? "take" : "takes")").foregroundStyle(Palette.muted)
                }
                .font(.mono(11))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
