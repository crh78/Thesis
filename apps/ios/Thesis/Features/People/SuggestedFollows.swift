import SwiftUI

/// Follow / Following pill, same look as the people lists.
struct FollowPill: View {
    let name: String
    let following: Bool
    var compact = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(following ? "Following" : "Follow")
                .font(.geist(compact ? 13 : 14, .semibold))
                .foregroundStyle(following ? Palette.text : Palette.bg)
                .padding(.horizontal, compact ? 14 : 16)
                .frame(maxWidth: compact ? .infinity : nil, minHeight: compact ? 32 : 36)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(following ? .regular.interactive() : .regular.tint(Palette.text).interactive(), in: .capsule)
        .accessibilityLabel(following ? "Unfollow \(name)" : "Follow \(name)")
    }
}

/// "Suggested for you": a horizontal row of people to follow, with why.
/// Hidden when there's nobody to suggest.
struct SuggestedFollowsRow: View {
    @Environment(AppState.self) private var app

    var body: some View {
        if !app.suggested.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Suggested for you")
                    .font(.geist(13, .semibold))
                    .foregroundStyle(Palette.muted)
                    .padding(.horizontal, 16)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(app.suggested) { SuggestionCard(suggestion: $0) }
                    }
                    .padding(.horizontal, 16)
                }
            }
        }
    }
}

private struct SuggestionCard: View {
    @Environment(AppState.self) private var app
    let suggestion: Suggestion

    var body: some View {
        let person = suggestion.person
        VStack(spacing: 5) {
            PersonLink(person: person) {
                VStack(spacing: 5) {
                    Avatar(name: person.avatar, size: 56).padding(.top, 8)
                    Text(person.name).font(.geist(14, .semibold)).lineLimit(1)
                    Text(person.handle).font(.geist(12)).foregroundStyle(Palette.muted).lineLimit(1)
                }
            }
            Text(suggestion.reason)
                .font(.geist(11))
                .foregroundStyle(Palette.muted)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .frame(height: 28, alignment: .top)
            FollowPill(name: person.name, following: app.isFollowing(person), compact: true) {
                withAnimation(.snappy) { app.toggleFollow(person) }
            }
            .padding(.top, 2)
        }
        .padding(12)
        .frame(width: 148)
        .background(Palette.tile, in: .rect(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Palette.hairline))
        .overlay(alignment: .topTrailing) {
            Button {
                withAnimation(.snappy) { app.dismissSuggestion(suggestion) }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Palette.muted)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss \(person.name)")
        }
    }
}

/// Vertical "Suggested for you" (top few) for screens that page sideways, like
/// the Following feed, where a horizontal carousel would fight the swipe.
struct SuggestedFollowsList: View {
    @Environment(AppState.self) private var app
    var limit = 3

    var body: some View {
        if !app.suggested.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Suggested for you").font(.geist(13, .semibold)).foregroundStyle(Palette.muted)
                    Spacer()
                    Button("See all") { app.go(to: .search) }
                        .font(.geist(13, .semibold))
                        .foregroundStyle(Palette.text)
                }
                ForEach(app.suggested.prefix(limit)) { suggestion in
                    let person = suggestion.person
                    HStack(spacing: 12) {
                        PersonLink(person: person) {
                            HStack(spacing: 12) {
                                Avatar(name: person.avatar, size: 40)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(person.name).font(.geist(15, .semibold)).lineLimit(1)
                                    Text("\(person.handle) · \(suggestion.reason)")
                                        .font(.geist(13)).foregroundStyle(Palette.muted).lineLimit(1)
                                }
                            }
                        }
                        Spacer(minLength: 8)
                        FollowPill(name: person.name, following: app.isFollowing(person)) {
                            withAnimation(.snappy) { app.toggleFollow(person) }
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
            .padding(.horizontal, 16)
        }
    }
}
