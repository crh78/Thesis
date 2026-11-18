import Foundation

/// A take to start, from outside the composer:
///
/// - From chat: `yourthesis(-dev)://take/new?claim=…&risk=medium`. The iMessage
///   agent links to `functions/v1/open`, which 302s here. Opening one skips the composer and goes
///   straight to building the basket.
/// - Copying an X call: the same, plus `source_url` and `source_label`, so the take is credited
///   ("via @KobeissiLetter on X").
/// - From the share sheet: `…://take/new?read=<url>&title=…&text=…`. No claim yet: Thesis reads the
///   article or post first, then opens the composer on the take it drafted (ThesisShare).
struct TakeLink: Identifiable, Hashable {
    let id = UUID()
    let claim: String
    let risk: Risk
    var source: TakeSource? = nil
    /// Share sheet: the page to read before there's a take.
    var read: ReadRequest? = nil

    struct ReadRequest: Hashable {
        let url: URL
        /// The page title and Safari's page text or selection, when the share sheet had them.
        let title: String?
        let text: String?
    }

    init?(url: URL) {
        guard url.host() == "take", url.path() == "/new",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        let value = { (name: String) in items.first { $0.name == name }?.value }
        // risk: low|medium|high. Older links also carry a horizon ("3 months"); takes have none
        // now (they run until the author sells, a year at most), so it's ignored.
        risk = Risk.allCases.first { $0.rawValue.lowercased() == value("risk")?.lowercased() } ?? .medium

        if let raw = value("read"), let page = URL(string: raw), ["http", "https"].contains(page.scheme?.lowercased()) {
            claim = ""
            read = ReadRequest(url: page, title: value("title").map { String($0.prefix(300)) },
                               text: value("text").map { String($0.prefix(4000)) })
            return
        }
        let claim = (value("claim") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard claim.count >= 5 else { return nil }
        self.claim = String(claim.prefix(280))
        source = Self.source(url: value("source_url"), label: value("source_label"))
    }

    /// A take drafted elsewhere (an X call in the app): straight to building, credited.
    init(claim: String, risk: String?, source: TakeSource?) {
        self.claim = claim
        self.risk = Risk.allCases.first { $0.rawValue.lowercased() == risk?.lowercased() } ?? .medium
        self.source = source
    }

    /// The deep link that opens this take (a raised X-call notification carries it).
    var url: URL? {
        var c = URLComponents()
        c.scheme = AppConfig.urlScheme
        c.host = "take"
        c.path = "/new"
        var items = [URLQueryItem(name: "claim", value: claim), URLQueryItem(name: "risk", value: risk.rawValue.lowercased())]
        if let source {
            items += [URLQueryItem(name: "source_url", value: source.url.absoluteString), URLQueryItem(name: "source_label", value: source.label)]
        }
        c.queryItems = items
        return c.url
    }

    private static func source(url: String?, label: String?) -> TakeSource? {
        guard let url, let u = URL(string: url), ["http", "https"].contains(u.scheme?.lowercased()),
              let label, !label.isEmpty else { return nil }
        let host = u.host()?.lowercased() ?? ""
        let isX = host == "x.com" || host.hasSuffix(".x.com") || host.hasSuffix("twitter.com")
        return TakeSource(url: u, label: String(label.prefix(60)), kind: isX ? "x" : "link")
    }
}

/// A published take opened from its web receipt.
struct TakeReceiptLink: Identifiable {
    let id: String

    init?(url: URL) {
        guard url.scheme == AppConfig.urlScheme, url.host() == "take",
              let uuid = UUID(uuidString: String(url.path().dropFirst())) else { return nil }
        id = uuid.uuidString.lowercased()
    }
}
