import SwiftUI

/// Geist roles:
/// - `geist`: UI text and big numbers
/// - `serif`: the take itself (a claim reads like an opinion, not a button)
/// - `mono`: data — tickers, weights, amounts, dates, ranks
/// - `pixel`: the wordmark and "Called it"
extension Font {
    static func geist(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        let name: String
        switch weight {
        case .medium: name = "Geist-Medium"
        case .semibold: name = "Geist-SemiBold"
        case .bold, .heavy, .black: name = "Geist-Bold"
        default: name = "Geist-Regular"
        }
        return .custom(name, size: size, relativeTo: style)
    }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .footnote) -> Font {
        let name: String
        switch weight {
        case .medium: name = "GeistMono-Medium"
        case .semibold, .bold, .heavy, .black: name = "GeistMono-SemiBold"
        default: name = "GeistMono-Regular"
        }
        return .custom(name, size: size, relativeTo: style)
    }

    static func serif(_ size: CGFloat, relativeTo style: Font.TextStyle = .title2) -> Font {
        .custom("GeistSerif-Regular", size: size, relativeTo: style)
    }

    static func pixel(_ size: CGFloat, relativeTo style: Font.TextStyle = .title2) -> Font {
        .custom("GeistPixel-Square", size: size, relativeTo: style)
    }
}

enum Fmt {
    /// "+14.0%" / "−4.8%" with a true minus sign.
    static func pct(_ value: Double, digits: Int = 1) -> String {
        // Signed by what's shown: −0.004% reads "+0.0%", never "−0.0%".
        let shown = pctShown(value, digits: digits)
        return (shown < 0 ? "−" : "+") + String(format: "%.\(digits)f%%", abs(shown))
    }

    /// The value as `pct` shows it (rounded to `digits`), for picking its color the same way.
    static func pctShown(_ value: Double, digits: Int = 1) -> Double {
        let scale = pow(10, Double(digits))
        let rounded = (value * scale).rounded() / scale
        return rounded == 0 ? 0 : rounded
    }

    /// "$20", "$22.80", "+$2,410", "−$310".
    static func usd(_ value: Double, cents: Bool = false, signed: Bool = false) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.locale = Locale(identifier: "en_US")
        let digits = (cents || value.rounded() != value) ? 2 : 0
        formatter.minimumFractionDigits = digits
        formatter.maximumFractionDigits = digits
        let body = formatter.string(from: NSNumber(value: abs(value))) ?? ""
        if signed { return (value < 0 ? "−" : "+") + body }
        return value < 0 ? "−" + body : body
    }

    /// "4.2%" (no sign), for rates like an APY.
    static func plainPct(_ value: Double) -> String {
        String(format: value < 10 ? "%.1f%%" : "%.0f%%", value)
    }

    /// An asset's price: "$187.61", "$4,056.68", "$0.0042".
    static func price(_ value: Double) -> String {
        guard value >= 0.01 else { return "$" + String(format: "%.4g", value) }
        return usd(value, cents: true)
    }

    /// "+$4.1k" for tight spaces.
    static func compact(_ value: Double) -> String {
        guard abs(value) >= 1000 else { return usd(value, signed: true) }
        return (value < 0 ? "−" : "+") + "$" + String(format: "%.1fk", abs(value) / 1000)
    }

    /// Splits "+$1,284.50" into "+$1,284" and ".50" so cents can be dimmed.
    /// `signed`: show "+" for gains (scores); off for balances.
    static func splitCents(_ value: Double, signed: Bool = true) -> (whole: String, cents: String) {
        let full = usd(value, cents: true, signed: signed)
        guard let dot = full.lastIndex(of: ".") else { return (full, "") }
        return (String(full[..<dot]), String(full[dot...]))
    }
}
