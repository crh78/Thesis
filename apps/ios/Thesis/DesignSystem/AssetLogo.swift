import SwiftUI
import UIKit

/// A pick's logo, round: the company's (by its ticker), the coin's, a private company's site icon,
/// Collector Crypt's for cards, or a symbol for cash, predictions and metals. A monogram while it loads or when there's
/// none. `ring` ties it to the pick's color in the basket donut.
///
/// Logos come from public image endpoints by ticker (no key, nothing about you is sent): stocks and
/// ETFs from Financial Modeling Prep, coins from CoinCap, private companies from their site's icon.
/// They're cached in memory and by URLCache.
struct AssetLogo: View {
    /// The underlying ticker ("NVDA", "BTC", "SPACEX", "XAU"); nil for picks without one.
    let key: String?
    let name: String
    /// The pick's kind label ("Stock", "ETF", "Earns interest", "Prediction · Yes", "Stock · 3x")
    /// or an asset's raw kind ("stock", "yield", "prediction").
    let kind: String
    var size: CGFloat = 32
    var ring: Color? = nil

    @State private var logo: LogoStore.Logo?

    var body: some View {
        ZStack {
            if let symbol = AssetLogo.symbol(kind: kind, key: key) {
                Circle().fill(symbol.tint.opacity(0.18))
                Image(systemName: symbol.name)
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(symbol.tint)
            } else if let logo {
                if logo.fullBleed {
                    Image(uiImage: logo.image).resizable().scaledToFill()
                } else {
                    Circle().fill(logo.light ? Color(white: 0.13) : Color.white)
                    Image(uiImage: logo.image).resizable().scaledToFit().padding(size * 0.18)
                }
            } else {
                Circle().fill(Palette.tile)
                Text(AssetLogo.monogram(key: key, name: name))
                    .font(.geist(size * 0.34, .semibold))
                    .foregroundStyle(Palette.text)
                    .minimumScaleFactor(0.6)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay {
            if let ring { Circle().strokeBorder(ring, lineWidth: max(1.5, size / 16)) }
        }
        .accessibilityHidden(true)
        .task(id: key) {
            guard AssetLogo.symbol(kind: kind, key: key) == nil else { return }
            logo = await LogoStore.shared.logo(for: AssetLogo.candidates(key: key, name: name, kind: kind))
        }
    }

    // MARK: Which logo

    private static let crypto: Set<String> = [
        "BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "LINK", "AVAX", "ENA", "SUI", "TON", "HYPE", "JUP",
        "TRX", "DOT", "LTC", "BCH", "NEAR", "APT", "ARB", "OP", "PEPE", "WIF", "BONK", "SHIB", "UNI", "AAVE",
        "XLM", "HBAR", "ATOM", "FIL", "INJ", "TIA", "SEI", "PYTH", "JTO", "RNDR", "RENDER", "TAO", "ONDO", "PENGU",
        "TRUMP", "FARTCOIN", "POPCAT", "XMR", "ETC", "ICP", "MKR", "LDO", "CRV", "ZEC", "KAITO", "VIRTUAL",
    ]

    /// Private companies (pre-IPO) by their site, for its icon.
    private static let sites: [String: String] = [
        "SPACEX": "spacex.com", "OPENAI": "openai.com", "ANTHROPIC": "anthropic.com", "KALSHI": "kalshi.com",
        "ANDURIL": "anduril.com", "NEURALINK": "neuralink.com", "POLYMARKET": "polymarket.com", "OURA": "ouraring.com",
        "FIGUREAI": "figure.ai", "XAI": "x.ai", "STRIPE": "stripe.com", "DATABRICKS": "databricks.com",
        "DISCORD": "discord.com", "RIPPLING": "rippling.com", "REVOLUT": "revolut.com", "PERPLEXITY": "perplexity.ai",
    ]

    private static func ticker(_ key: String?) -> String? {
        guard let k = key?.uppercased(), k.range(of: #"^[A-Z0-9.]{1,12}$"#, options: .regularExpression) != nil else { return nil }
        return k
    }

    /// Cash, predictions and metals get a symbol, not a logo. Cards get Collector Crypt's logo (`candidates`).
    static func symbol(kind: String, key: String?) -> (name: String, tint: Color)? {
        let k = kind.lowercased()
        if k == "yield" || k.hasPrefix("earns") || k == "cash" { return ("dollarsign", Palette.up) }
        if k.hasPrefix("prediction") { return ("percent", Color(red: 0.55, green: 0.42, blue: 0.94)) }
        switch ticker(key) {
        case "XAU": return ("circle.hexagongrid.fill", Color(red: 0.86, green: 0.68, blue: 0.22))
        case "XAG": return ("circle.hexagongrid.fill", Color(white: 0.78))
        default: return nil
        }
    }

    /// A Collector Crypt card leg ("card", "Cards", "Card · …"): every one shows Collector Crypt's logo.
    static func isCard(_ kind: String) -> Bool { kind.range(of: #"^cards?\b"#, options: [.regularExpression, .caseInsensitive]) != nil }
    /// Collector Crypt's site icon, from the same public icon endpoint as the private companies'.
    static let collectorCryptLogo = URL(string: "https://www.google.com/s2/favicons?domain=collectorcrypt.com&sz=128")!

    static func candidates(key: String?, name: String, kind: String) -> [URL] {
        if isCard(kind) { return [collectorCryptLogo] }
        guard let t = ticker(key) else { return [] }
        let stock = URL(string: "https://financialmodelingprep.com/image-stock/\(t).png")
        let coin = URL(string: "https://assets.coincap.io/assets/icons/\(t.lowercased())@2x.png")
        if let site = sites[t] { return [URL(string: "https://www.google.com/s2/favicons?domain=\(site)&sz=128")].compactMap { $0 } }
        if kind.lowercased().hasPrefix("pre") { return [] }
        // A coin's ticker can also be a stock's ("SOL" is ReneSola): coins first for known coins.
        return (crypto.contains(t) ? [coin, stock] : [stock]).compactMap { $0 }
    }

    static func monogram(key: String?, name: String) -> String {
        if let t = ticker(key), t.count <= 4 { return t }
        let words = name.split(separator: " ").prefix(2)
        return words.map { String($0.prefix(1)).uppercased() }.joined()
    }
}

/// Loaded logos, by URL list. A logo that fails to load is remembered as none, so lists don't
/// refetch it on every scroll.
actor LogoStore {
    static let shared = LogoStore()

    struct Logo: @unchecked Sendable {
        let image: UIImage
        /// Its own background fills the frame (the Bitcoin coin): no backing circle.
        let fullBleed: Bool
        /// A light logo on transparent: shown on dark, others on white.
        let light: Bool
    }

    private var cache: [String: Logo?] = [:]
    private var inFlight: [String: Task<Logo?, Never>] = [:]

    func logo(for urls: [URL]) async -> Logo? {
        guard !urls.isEmpty else { return nil }
        let id = urls.map(\.absoluteString).joined(separator: "|")
        if let hit = cache[id] { return hit }
        if let running = inFlight[id] { return await running.value }
        let task = Task<Logo?, Never> {
            for url in urls {
                if let logo = await Self.load(url) { return logo }
            }
            return nil
        }
        inFlight[id] = task
        let result = await task.value
        cache[id] = result
        inFlight[id] = nil
        return result
    }

    private static func load(_ url: URL) async -> Logo? {
        var request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 8)
        request.setValue("image/*", forHTTPHeaderField: "accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              (http.value(forHTTPHeaderField: "content-type") ?? "").hasPrefix("image"),
              data.count > 300, let image = UIImage(data: data), image.size.width >= 32 else { return nil }
        let (opaque, luminance) = analyze(image)
        return Logo(image: image, fullBleed: opaque > 0.92, light: luminance > 0.78)
    }

    /// How much of the image is opaque, and how light its opaque pixels are (0…1), from a 16×16
    /// sample.
    private static func analyze(_ image: UIImage) -> (opaque: Double, luminance: Double) {
        guard let cg = image.cgImage else { return (0, 0.5) }
        let side = 16
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        guard let ctx = CGContext(data: &pixels, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return (0, 0.5) }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: side, height: side))
        var opaque = 0.0, lum = 0.0, n = 0.0
        for i in stride(from: 0, to: pixels.count, by: 4) {
            let a = Double(pixels[i + 3]) / 255
            guard a > 0.5 else { continue }
            opaque += 1
            let r = Double(pixels[i]) / 255 / a, g = Double(pixels[i + 1]) / 255 / a, b = Double(pixels[i + 2]) / 255 / a
            lum += 0.2126 * r + 0.7152 * g + 0.0722 * b
            n += 1
        }
        return (opaque / Double(side * side), n > 0 ? lum / n : 0.5)
    }
}
