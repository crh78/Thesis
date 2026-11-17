import SwiftUI

/// Saved takes (X's Bookmarks). Swipe a row to remove it.
struct SavedView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        let takes = app.savedTakes

        Group {
            if takes.isEmpty {
                ContentUnavailableView(
                    "No saved takes",
                    systemImage: "bookmark",
                    description: Text("Tap the bookmark on any take to keep it here.")
                )
            } else {
                List {
                    ForEach(takes) { take in
                        NavigationLink(value: take) {
                            TakeListRow(take: take)
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .listRowSeparatorTint(Palette.hairline)
                        .swipeActions {
                            Button(role: .destructive) {
                                withAnimation { app.toggleSave(take) }
                            } label: {
                                Label("Remove", systemImage: "bookmark.slash")
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(ThesisBackground())
        .navigationTitle("Saved")
        .navigationBarTitleDisplayMode(.inline)
    }
}
