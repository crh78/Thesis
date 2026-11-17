import SwiftUI

/// Wraps anything that shows a person (avatar, name, row) so tapping it opens
/// their profile. Tapping yourself goes to the Me tab instead. Needs a
/// NavigationStack with `.peopleDestinations()`.
struct PersonLink<Label: View>: View {
    @Environment(AppState.self) private var app
    let person: Person
    @ViewBuilder var label: Label

    var body: some View {
        if app.isMe(person) {
            Button { app.go(to: .me) } label: { label }
                .buttonStyle(.plain)
                .accessibilityHint("Opens your profile")
        } else {
            NavigationLink(value: PeopleRoute.person(person)) { label }
                .buttonStyle(.plain)
                .accessibilityHint("Opens \(person.name)'s profile")
        }
    }
}

/// Someone else's profile: who they are, Follow, counts, record and their takes.
struct PersonProfileView: View {
    @Environment(AppState.self) private var app
    let person: Person

    @State private var detail: PersonDetail?
    /// Whether you followed them when the page opened, so the follower count
    /// can move with your Follow button without a reload.
    @State private var followedAtLoad: Bool?

    private var shown: Person { detail?.person ?? person }

    private var followers: Int? {
        guard let detail, let followedAtLoad else { return nil }
        let now = app.isFollowing(shown)
        return detail.followers + (now ? 1 : 0) - (followedAtLoad ? 1 : 0)
    }

    var body: some View {
        let p = shown
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .bottom) {
                        Avatar(name: p.avatar, size: 72)
                        Spacer()
                        FollowPill(name: p.name, following: app.isFollowing(p)) {
                            withAnimation(.snappy) { app.toggleFollow(p) }
                        }
                    }
                    Text(p.name).font(.geist(24, .bold)).padding(.top, 4)
                    HStack(spacing: 6) {
                        Text(p.handle).font(.geist(14)).foregroundStyle(Palette.muted)
                        if p.followsYou {
                            Text("Follows you")
                                .font(.geist(11, .medium))
                                .foregroundStyle(Palette.muted)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Palette.tile, in: .rect(cornerRadius: 5))
                        }
                    }
                    .padding(.top, -6)
                    if !p.bio.isEmpty {
                        Text(p.bio).font(.geist(14)).fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: 16) {
                        countLink(detail?.following, .following, p)
                        countLink(followers, .followers, p)
                    }
                    .font(.geist(14))
                    HStack(spacing: 6) {
                        Text(Fmt.usd(p.made, signed: true))
                            .foregroundStyle(p.made >= 0 ? Palette.up : Palette.down)
                        let takes = detail?.takes.count ?? p.takes
                        Text("MADE · \(String(format: "%.1f", p.returnPct))% RETURN · \(takes) \(takes == 1 ? "TAKE" : "TAKES")")
                            .foregroundStyle(Palette.muted)
                    }
                    .font(.mono(11))
                    if app.isOnFork {
                        // The second score: what their takes made for the people who backed them.
                        HStack(spacing: 6) {
                            Text(Fmt.usd(p.backersMade, signed: true))
                                .foregroundStyle(p.backersMade >= 0 ? Palette.up : Palette.down)
                            Text("MADE FOR BACKERS · \(String(format: "%.1f", p.backersPct))% RETURN")
                                .foregroundStyle(Palette.muted)
                        }
                        .font(.mono(11))
                        .padding(.top, -4)
                    }
                }
                .padding(.horizontal, 18)

                Hairline().padding(.top, 16)

                Text("Takes")
                    .font(.geist(13, .semibold))
                    .foregroundStyle(Palette.muted)
                    .padding(.horizontal, 16)
                    .padding(.top, 18)
                    .padding(.bottom, 4)

                if let detail {
                    ForEach(detail.takes) { take in
                        NavigationLink(value: take) { TakeListRow(take: take) }
                            .buttonStyle(.plain)
                        Hairline()
                    }
                    if detail.takes.isEmpty {
                        ContentUnavailableView("No takes yet", systemImage: "text.bubble",
                                               description: Text("\(p.name) hasn't posted a take."))
                            .padding(.top, 30)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(.bottom, 24)
        }
        .background(ThesisBackground())
        .navigationTitle(p.handle)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            let loaded = await app.personDetail(person)
            followedAtLoad = app.isFollowing(loaded.person)
            detail = loaded
        }
        .refreshable {
            let loaded = await app.personDetail(person)
            followedAtLoad = app.isFollowing(loaded.person)
            detail = loaded
        }
    }

    /// The count opens their list; a lock shows when they keep it private.
    private func countLink(_ value: Int?, _ tab: ConnectionsTab, _ person: Person) -> some View {
        let hidden = detail.map { !$0.privacy.shows(tab) } ?? false
        return NavigationLink(value: PeopleRoute.personConnections(person, tab)) {
            HStack(spacing: 4) {
                Text(value.map(String.init) ?? "–").fontWeight(.semibold).foregroundStyle(Palette.text)
                Text(tab.rawValue).foregroundStyle(Palette.muted)
                if hidden {
                    Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(Palette.muted)
                }
            }
            .frame(minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(value.map(String.init) ?? "–") \(tab.rawValue)\(hidden ? ", private" : "")")
        .accessibilityIdentifier("person-\(tab.rawValue.lowercased())")
    }
}
