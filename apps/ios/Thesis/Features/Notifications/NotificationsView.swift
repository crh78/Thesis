import SwiftUI

/// Your inbox: new takes from people you follow, comments, trades and fades on your takes,
/// settlements, badges and the daily positions digest. Opening it marks everything read.
struct NotificationsView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var take: Take?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(app.notifications) { n in
                        if let link = n.copyLink {
                            // An X account you copy made a call: open its take, basket built.
                            Button {
                                dismiss()
                                Task {
                                    try? await Task.sleep(for: .milliseconds(500))
                                    app.openedTake = link
                                }
                            } label: {
                                NotificationRow(n: n)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("notification-x-call")
                        } else if let takeID = n.takeId {
                            Button {
                                Task { take = await app.notificationTake(takeID) }
                            } label: {
                                NotificationRow(n: n)
                            }
                            .buttonStyle(.plain)
                        } else {
                            NotificationRow(n: n)
                        }
                        Hairline()
                    }
                    if app.notifications.isEmpty {
                        Text("Nothing yet. Follow people to hear when they post, and trade a take to get a daily update on it.")
                            .font(.geist(14))
                            .foregroundStyle(Palette.muted)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity, minHeight: 160)
                            .padding(.horizontal, 32)
                    }
                }
                .padding(.horizontal, 18)
            }
            .background(ThesisBackground())
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $take) { TakeDetailView(take: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .refreshable { await app.refreshNotifications() }
            .task {
                await app.refreshNotifications()
                await app.markNotificationsRead()
            }
        }
        .accessibilityIdentifier("notifications")
    }
}

private struct NotificationRow: View {
    let n: AppNotification

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: n.symbol)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 34, height: 34)
                .background(Circle().fill(Palette.text.opacity(0.08)))
            VStack(alignment: .leading, spacing: 3) {
                Text(n.title).font(.geist(15, n.read ? .regular : .semibold))
                if !n.body.isEmpty {
                    Text(n.body).font(.geist(13)).foregroundStyle(Palette.muted).lineLimit(2)
                }
                Text(n.createdAt, format: .relative(presentation: .named))
                    .font(.mono(11))
                    .foregroundStyle(Palette.muted)
            }
            Spacer(minLength: 0)
            if !n.read {
                Circle().fill(Palette.up).frame(width: 8, height: 8).padding(.top, 6)
            }
        }
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
