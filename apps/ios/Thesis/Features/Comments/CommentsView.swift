import SwiftUI

private enum CommentSort: String, CaseIterable, Identifiable {
    case top = "Top", newest = "Newest", backers = "Traders", faders = "Faders"
    var id: String { rawValue }
}

struct CommentsView: View {
    let take: Take

    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var sort: CommentSort = .top
    @State private var comments: [Comment] = []
    @State private var loading = true
    @State private var loadError: String?
    @State private var draft = ""
    @State private var replyingTo: Comment?
    @State private var posting = false
    @FocusState private var fieldFocused: Bool

    /// Backers / Faders need positions, which arrive with paper trading.
    private var sorts: [CommentSort] {
        comments.contains { $0.position != nil } ? CommentSort.allCases : [.top, .newest]
    }

    private var sorted: [Comment] {
        switch sort {
        case .top: return comments.sorted { $0.likes > $1.likes }
        case .newest: return comments.sorted { $0.minutesAgo < $1.minutesAgo }
        case .backers: return comments.filter { $0.position.map { !$0.isFade } ?? false }
        case .faders: return comments.filter { $0.position?.isFade ?? false }
        }
    }

    /// Mock data has a handful of comments under bigger mockup counts; keep the mockup's number there.
    private var count: Int { app.isLive ? comments.reduce(0) { $0 + 1 + $1.replies.count } : take.comments }
    private var canPost: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !posting }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("On \(take.author.name)'s take · \(take.claim)")
                        .font(.geist(13))
                        .foregroundStyle(Palette.muted)
                        .lineLimit(1)
                        .padding(.bottom, 12)

                    Picker("Sort", selection: $sort) {
                        ForEach(sorts) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.bottom, 6)

                    if loading && comments.isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    } else if let loadError, comments.isEmpty {
                        ContentUnavailableView {
                            Label("Couldn't load comments", systemImage: "wifi.exclamationmark")
                        } description: {
                            Text(loadError)
                        } actions: {
                            Button("Try again") { Task { await load() } }.buttonStyle(.glass)
                        }
                    } else if comments.isEmpty {
                        ContentUnavailableView("No comments yet", systemImage: "bubble.left.and.bubble.right",
                                               description: Text("Say what you think."))
                            .padding(.top, 20)
                    }

                    ForEach(Array(sorted.enumerated()), id: \.element.id) { index, comment in
                        if index > 0 { Hairline() }
                        VStack(alignment: .leading, spacing: 8) {
                            CommentRow(comment: comment, onLike: like, onReply: reply)
                            ForEach(comment.replies) { reply in
                                CommentRow(comment: reply, avatarSize: 30, onLike: like, onReply: self.reply)
                                    .padding(.leading, 46)
                            }
                        }
                        .padding(.vertical, 12)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
            }
            .navigationTitle(loading && comments.isEmpty ? "Comments" : "Comments · \(count)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
            }
            .safeAreaBar(edge: .bottom) { composer }
            .task { await load() }
            .navigationDestination(for: Take.self) { TakeDetailView(take: $0) }
            .peopleDestinations()
            .onChange(of: sorts) { if !sorts.contains(sort) { sort = .top } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let replyingTo {
                HStack(spacing: 6) {
                    Text("Replying to \(app.isMe(replyingTo.author) ? "yourself" : replyingTo.author.name)")
                    Button { self.replyingTo = nil } label: { Image(systemName: "xmark.circle.fill") }
                        .accessibilityLabel("Cancel reply")
                }
                .font(.geist(12, .semibold))
                .foregroundStyle(Palette.muted)
                .padding(.horizontal, 10)
                .frame(height: 26)
            } else if !app.isLive {
                Text("Commenting as a trader · $20 in")
                    .font(.geist(12, .semibold))
                    .foregroundStyle(Palette.up)
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .background(Palette.upSoft, in: .capsule)
            }
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    TextField(replyingTo == nil ? "Add a comment…" : "Add a reply…", text: $draft, axis: .vertical)
                        .lineLimit(1...4)
                        .font(.geist(15))
                        .focused($fieldFocused)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 12)
                        .frame(minHeight: 48)
                        .glassEffect(.regular, in: .rect(cornerRadius: 24))
                        .accessibilityLabel("Comment")
                    Button(action: post) {
                        Group {
                            if posting {
                                ProgressView()
                            } else {
                                Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold))
                            }
                        }
                        .frame(width: 48, height: 48)
                        .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .circle)
                    .disabled(!canPost)
                    .accessibilityLabel("Post comment")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }

    // MARK: Actions

    private func load() async {
        loading = true
        loadError = nil
        do {
            comments = try await app.comments(on: take)
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? "Try again in a moment."
        }
        loading = false
    }

    private func post() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        posting = true
        Task {
            do {
                let thread = try await app.comment(on: take, text: text, replyingTo: replyingTo)
                withAnimation(.snappy) { comments = thread }
                draft = ""
                replyingTo = nil
                fieldFocused = false
                sort = .newest
            } catch {
                app.actionError = (error as? LocalizedError)?.errorDescription ?? "Couldn't post your comment."
            }
            posting = false
        }
    }

    private func reply(to comment: Comment) {
        replyingTo = comment
        fieldFocused = true
    }

    /// Flip the like right away; put it back if the request fails.
    private func like(_ comment: Comment) {
        let on = !comment.liked
        update(comment.id) { $0.liked = on; $0.likes += on ? 1 : -1 }
        Task {
            do {
                try await app.setLiked(comment, on)
            } catch {
                update(comment.id) { $0.liked = !on; $0.likes += on ? -1 : 1 }
                app.actionError = (error as? LocalizedError)?.errorDescription ?? "Couldn't like that."
            }
        }
    }

    private func update(_ id: String, _ change: (inout Comment) -> Void) {
        for i in comments.indices {
            if comments[i].id == id { change(&comments[i]); return }
            if let j = comments[i].replies.firstIndex(where: { $0.id == id }) {
                change(&comments[i].replies[j])
                return
            }
        }
    }
}

/// A comment with the commenter's position (once positions exist), so you can
/// see who has money on it.
struct CommentRow: View {
    @Environment(AppState.self) private var app
    let comment: Comment
    var avatarSize: CGFloat = 36
    var compact = false
    var onLike: ((Comment) -> Void)? = nil
    var onReply: ((Comment) -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            PersonLink(person: comment.author) { Avatar(name: comment.author.avatar, size: avatarSize) }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    PersonLink(person: comment.author) {
                        Text(app.isMe(comment.author) ? "You" : comment.author.name)
                            .font(.geist(14, .semibold))
                    }
                    if let position = comment.position {
                        Text(position.label)
                            .font(.geist(12, .semibold))
                            .foregroundStyle(position.color)
                    } else {
                        Text(comment.author.handle).font(.geist(12)).foregroundStyle(Palette.muted)
                    }
                    Text("· \(comment.age)").font(.geist(12)).foregroundStyle(Palette.muted)
                    if compact {
                        Spacer()
                        HStack(spacing: 4) {
                            Image(systemName: comment.liked ? "heart.fill" : "heart")
                            Text("\(comment.likes)")
                        }
                        .font(.mono(12))
                        .foregroundStyle(comment.liked ? Palette.down : Palette.muted)
                    }
                }
                .lineLimit(1)
                Text(comment.text)
                    .font(.geist(15))
                    .fixedSize(horizontal: false, vertical: true)

                if !compact {
                    HStack(spacing: 2) {
                        Button { onLike?(comment) } label: {
                            HStack(spacing: 6) {
                                Image(systemName: comment.liked ? "heart.fill" : "heart")
                                    .symbolEffect(.bounce, value: comment.liked)
                                Text("\(comment.likes)").font(.mono(13))
                            }
                            .foregroundStyle(comment.liked ? Palette.down : Palette.muted)
                            .padding(.horizontal, 10)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .sensoryFeedback(.selection, trigger: comment.liked)
                        .accessibilityLabel(comment.liked ? "Unlike" : "Like")

                        Button("Reply") { onReply?(comment) }
                            .font(.geist(13, .semibold))
                            .foregroundStyle(Palette.muted)
                            .padding(.horizontal, 10)
                            .frame(minHeight: 44)
                    }
                    .padding(.leading, -10)
                }
            }
        }
    }
}
