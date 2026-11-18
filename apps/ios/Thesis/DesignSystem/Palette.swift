import SwiftUI
import UIKit

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(uiColor: UIColor(hex: hex, alpha: alpha))
    }

    /// A color that resolves per light / dark appearance.
    static func adaptive(dark: UIColor, light: UIColor) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

/// Design tokens. Source of truth: docs/design/README.md.
enum Palette {
    static let bg = Color.adaptive(dark: UIColor(hex: 0x07080B), light: UIColor(hex: 0xF6F7F9))
    static let text = Color.adaptive(dark: UIColor(hex: 0xF2F3F5), light: UIColor(hex: 0x0F1419))
    static let muted = Color.adaptive(dark: UIColor(hex: 0x9AA0AA), light: UIColor(hex: 0x535B66))
    static let hairline = Color.adaptive(dark: UIColor(white: 1, alpha: 0.09), light: UIColor(hex: 0x0F1419, alpha: 0.09))
    static let tile = Color.adaptive(dark: UIColor(white: 1, alpha: 0.06), light: UIColor(hex: 0x0F1419, alpha: 0.05))

    /// Gains, "Trade", traders.
    static let up = Color.adaptive(dark: UIColor(hex: 0xA6E3B8), light: UIColor(hex: 0x1E7A43))
    /// Losses, "Fade", faders.
    static let down = Color.adaptive(dark: UIColor(hex: 0xF2A9C2), light: UIColor(hex: 0xB23A68))
    static let upSoft = Color.adaptive(dark: UIColor(hex: 0xA6E3B8, alpha: 0.12), light: UIColor(hex: 0x1E7A43, alpha: 0.08))
    static let downSoft = Color.adaptive(dark: UIColor(hex: 0xF2A9C2, alpha: 0.12), light: UIColor(hex: 0xB23A68, alpha: 0.08))

    static let backFill = Color(hex: 0xA9E3BA)
    static let backInk = Color(hex: 0x06210F)
    static let fadeFill = Color(hex: 0xF3B6CC)
    static let fadeInk = Color(hex: 0x330A1A)

    /// The color for a percent shown with `Fmt.pct`: picked by the rounded value, so −0.004%
    /// (shown "+0.0%") reads as a gain, never pink.
    static func sign(pct: Double, digits: Int = 1) -> Color {
        Fmt.pctShown(pct, digits: digits) < 0 ? down : up
    }

    static let gold = Color.adaptive(dark: UIColor(hex: 0xF2D38A), light: UIColor(hex: 0x8A6A12))

    /// Categorical chart palette, CVD-validated in this order. Color follows the
    /// pick, never its rank.
    static func series(_ slot: Int) -> Color {
        // Ten, one per pick a basket can hold (the last five came with basket editing).
        let dark: [UInt32] = [0x3987E5, 0xD95926, 0x199E70, 0xC98500, 0xD55181,
                              0x8B6CEF, 0x2BB3C0, 0x8FB339, 0xB07A4F, 0x7C8BA1]
        let light: [UInt32] = [0x2A78D6, 0xEB6834, 0x1BAF7A, 0xEDA100, 0xE87BA4,
                               0x7457E0, 0x1C9FAD, 0x76A02A, 0x9C6538, 0x67768C]
        let i = max(0, min(slot, dark.count - 1))
        return .adaptive(dark: UIColor(hex: dark[i]), light: UIColor(hex: light[i]))
    }
}

/// Near-flat background with a faint glow at the top, so glass controls have
/// something to refract without putting cards behind content.
struct ThesisBackground: View {
    var body: some View {
        ZStack {
            Palette.bg
            RadialGradient(
                colors: [Color(hex: 0x8296FF, alpha: 0.13), .clear],
                center: .top, startRadius: 0, endRadius: 380
            )
        }
        .ignoresSafeArea()
    }
}

enum Side: String, Hashable {
    case back, fade

    // User-facing word is "Trade" (rhymes with Fade); `.back` is just the code name.
    var title: String { self == .back ? "Trade" : "Fade" }
    var fill: Color { self == .back ? Palette.backFill : Palette.fadeFill }
    var ink: Color { self == .back ? Palette.backInk : Palette.fadeInk }
    var text: Color { self == .back ? Palette.up : Palette.down }
    /// Quiet tint for small pills (feed rows).
    var soft: Color { self == .back ? Palette.upSoft : Palette.downSoft }
    var arrow: String { self == .back ? "arrow.up.right" : "arrow.down.right" }
    /// The lowercase word ("trade" / "fade"), as in accessibility identifiers.
    var serverValue: String { self == .back ? "trade" : "fade" }
}
