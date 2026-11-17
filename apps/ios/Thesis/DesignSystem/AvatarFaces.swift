import SwiftUI

/// Built-in profile avatars: DiceBear "Notionists" faces (CC0) in the same
/// line style as the people already in the app, with tinted skin, on a pastel
/// circle. `name` is what's stored in `profiles.avatar_icon`; never rename
/// one that shipped.
enum AvatarIcons {
    enum Look: String, CaseIterable { case men = "Men", women = "Women" }

    /// 33 faces with a spread of skin tones, hair and features, so people of
    /// every background can find themselves. person-01…17 read as men, 18…33 as
    /// women. person-12 (Sikh man in a dastar) and person-13 (locs) are drawn
    /// for us on Notionists bases; see docs/design/assets/avatars/source/.
    static let all: [(name: String, asset: String, look: Look)] = (1...33).map { i in
        let n = String(format: "person-%02d", i)
        return (n, "avatar-\(n)", i <= 17 ? .men : .women)
    }

    /// Picker order: men and women alternate under "All".
    static func faces(_ look: Look?) -> [(name: String, asset: String, look: Look)] {
        if let look { return all.filter { $0.look == look } }
        // Alternate, then append whichever list is longer.
        let men = all.filter { $0.look == .men }, women = all.filter { $0.look == .women }
        return zip(men, women).flatMap { [$0, $1] } + men.dropFirst(women.count) + women.dropFirst(men.count)
    }

    /// Background colors, by index (`profiles.avatar_color`, 0…15 allowed).
    /// The first three match the existing avatars (pink, lavender, sky).
    static let colors: [UInt32] = [0xFFD5DC, 0xC0AEDE, 0xB6E3F4, 0xD1D4F9, 0xFFDFBF, 0xC8ECD4, 0xFFFFFF]

    static func asset(for name: String) -> String? { all.first { $0.name == name }?.asset }

    static func color(_ index: Int) -> Color {
        Color(hex: colors[((index % colors.count) + colors.count) % colors.count])
    }

    /// A stable default per user, so everyone starts with "their" face.
    static func defaultChoice(for seed: String) -> (name: String, color: Int) {
        var hash: UInt64 = 5381
        for byte in seed.utf8 { hash = (hash &* 33) &+ UInt64(byte) }
        return (all[Int(hash % UInt64(all.count))].name, Int((hash / UInt64(all.count)) % UInt64(colors.count)))
    }
}

/// A built-in face on a flat pastel circle, like the bundled demo avatars.
struct IconAvatar: View {
    let icon: String
    let color: Int
    var size: CGFloat = 40

    var body: some View {
        ZStack {
            Circle().fill(AvatarIcons.color(color))
            if let asset = AvatarIcons.asset(for: icon) {
                Image(asset).resizable().scaledToFill()
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}

/// Built-in face avatars are stored in `profiles.avatar_url` as
/// `face:<name>:<color>` (e.g. `face:person-05:2`), next to `asset:<name>`
/// (bundled demo images) and `https://` (uploaded photos). `Avatar` draws all
/// three, so a chosen face shows everywhere a person does.
enum AvatarFace {
    static func encode(_ name: String, color: Int) -> String { "face:\(name):\(color)" }

    static func parse(_ value: String) -> (name: String, color: Int)? {
        let parts = value.split(separator: ":")
        guard parts.count == 3, parts[0] == "face", let color = Int(parts[2]),
              AvatarIcons.asset(for: String(parts[1])) != nil else { return nil }
        return (String(parts[1]), color)
    }

    /// The face someone gets before choosing one: stable per seed (handle).
    static func defaultValue(for seed: String) -> String {
        let pick = AvatarIcons.defaultChoice(for: seed)
        return encode(pick.name, color: pick.color)
    }
}
