import SwiftUI

/// X-style sidebar opened from your avatar on Home.
struct ProfileDrawer: View {
    @Environment(AppState.self) private var app
    @Environment(SessionStore.self) private var session

    var body: some View {
        let me = app.me

        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Button { app.go(to: .me) } label: {
                    Avatar(name: me.avatar, size: 48)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Your profile")

                VStack(alignment: .leading, spacing: 2) {
                    Text(me.name).font(.geist(20, .bold))
                    Text(me.handle)
                        .font(.geist(15)).foregroundStyle(Palette.muted)
                }

                HStack(spacing: 16) {
                    countButton(app.followingCount, "Following") { app.open(.connections(.following)) }
                    countButton(app.followerCount, "Followers") { app.open(.connections(.followers)) }
                }

                HStack(spacing: 6) {
                    Text(Fmt.usd(me.made, cents: true, signed: true)).foregroundStyle(me.made < 0 ? Palette.down : Palette.up)
                    Text("made · \(Fmt.pct(me.returnPct))").foregroundStyle(Palette.muted)
                }
                .font(.mono(12))
                if app.isOnFork {
                    HStack(spacing: 6) {
                        Text(Fmt.usd(me.backersMade, cents: true, signed: true)).foregroundStyle(me.backersMade < 0 ? Palette.down : Palette.up)
                        Text("made for backers · \(Fmt.pct(me.backersPct))").foregroundStyle(Palette.muted)
                    }
                    .font(.mono(12))
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 20)

            Hairline().padding(.horizontal, 24)

            VStack(alignment: .leading, spacing: 2) {
                DrawerItem(title: "Profile", systemImage: "person") { app.go(to: .me) }
                DrawerItem(title: "Saved", systemImage: "bookmark", badge: app.saved.isEmpty ? nil : "\(app.saved.count)") {
                    app.open(.saved)
                }
                DrawerItem(title: "Followers", systemImage: "person.2") { app.open(.connections(.followers)) }
                DrawerItem(title: "Scores", systemImage: "trophy") { app.go(to: .scores) }
                DrawerItem(title: "Add cash", systemImage: "plus.circle", badge: Fmt.usd(app.balance, cents: true)) {
                    app.addCash()
                }
                if !app.isOnFork {
                    DrawerItem(title: "Withdraw", systemImage: "arrow.up.circle") { app.startWithdraw() }
                }
                DrawerItem(title: "Cash activity", systemImage: "list.bullet.rectangle") { app.openCash() }
            }
            .padding(.horizontal, 12)
            .padding(.top, 12)

            Spacer()

            Hairline().padding(.horizontal, 24)
            Button { app.open(.settings) } label: {
                HStack(spacing: 14) {
                    Image(systemName: "gearshape").font(.system(size: 18)).frame(width: 26)
                    Text("Settings").font(.geist(16, .semibold))
                    Spacer()
                }
                .foregroundStyle(Palette.text)
                .padding(.horizontal, 24)
                .frame(minHeight: 56)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings")
            LogOutRow()
        }
        .padding(.top, 8)
        .frame(width: 300)
        .frame(maxHeight: .infinity, alignment: .top)
        .background {
            ThesisBackground()
                .overlay(alignment: .trailing) { Rectangle().fill(Palette.hairline).frame(width: 1) }
                .ignoresSafeArea()
        }
    }

    private func countButton(_ count: Int, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text("\(count)").font(.geist(14, .semibold)).foregroundStyle(Palette.text)
                Text(label).font(.geist(14)).foregroundStyle(Palette.muted)
            }
            .frame(minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(count) \(label)")
    }
}

private struct DrawerItem: View {
    let title: String
    let systemImage: String
    var badge: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: systemImage).font(.system(size: 21)).frame(width: 28)
                Text(title).font(.geist(20, .bold))
                Spacer()
                if let badge {
                    Text(badge).font(.mono(12)).foregroundStyle(Palette.muted)
                }
            }
            .foregroundStyle(Palette.text)
            .padding(.horizontal, 12)
            .frame(minHeight: 54)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
