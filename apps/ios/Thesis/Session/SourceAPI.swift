import Foundation

/// Takes from what you read, and copying X accounts: the `source` edge function
/// (supabase/functions/source).
extension SocialAPI {
    /// An article or X post → a take to edit. `title`/`text`: what the share sheet had; the page
    /// itself is fetched here on the phone first, since many news sites turn servers away.
    func draftTake(from request: TakeLink.ReadRequest) async throws -> SourceDraft {
        var body: [String: Any] = ["url": request.url.absoluteString]
        if let title = request.title { body["title"] = title }
        if let text = request.text { body["text"] = text }
        if let html = await PageReader.html(request.url) { body["html"] = html }
        let data = try await function("source", "POST", "", body: try JSONSerialization.data(withJSONObject: body))
        return try Self.decoder.decode(SourceDraft.self, from: data)
    }

    /// Your new take came from this (once per take).
    func attachSource(_ takeID: String, _ source: TakeSource) async throws {
        let body: [String: Any] = ["take_id": takeID, "url": source.url.absoluteString, "label": source.label, "kind": source.kind]
        _ = try await function("source", "POST", "attach", body: try JSONSerialization.data(withJSONObject: body))
    }

    /// The X accounts you copy, each with its recent calls.
    func xAccounts() async throws -> [XAccount] {
        struct Body: Decodable { let accounts: [XAccount] }
        return try Self.decoder.decode(Body.self, from: try await function("source", "GET", "x", body: nil)).accounts
    }

    /// Copy an X account ("@KobeissiLetter", or a profile link). The first person to copy one
    /// waits while its recent posts are read (several seconds).
    func copyX(_ handle: String) async throws -> XAccount {
        struct Body: Decodable { let account: XAccount }
        let path = "x/\(handle.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? handle)"
        return try Self.decoder.decode(Body.self, from: try await function("source", "PUT", path, body: nil)).account
    }

    func stopCopyingX(_ handle: String) async throws {
        _ = try await function("source", "DELETE", "x/\(handle)", body: nil)
    }
}

/// What `source` drafted from an article or post.
struct SourceDraft: Decodable {
    let claim: String
    let risk: String
    let source: Info

    struct Info: Decodable {
        let url: URL
        let label: String
        let kind: String
        let title: String?
    }

    var takeSource: TakeSource { TakeSource(url: source.url, label: source.label, kind: source.kind) }
}

/// An X account you copy.
struct XAccount: Identifiable, Hashable, Decodable {
    /// Lowercase.
    let handle: String
    /// As X shows it ("KobeissiLetter").
    let username: String
    let name: String?
    let avatarUrl: URL?
    let calls: [XCall]

    var id: String { handle }
}

/// A post from an account you copy that makes a market call, with the take drafted from it.
struct XCall: Identifiable, Hashable, Decodable {
    let postId: String
    let url: URL
    let text: String
    let postedAt: Date
    let claim: String
    let risk: String?

    var id: String { postId }

    func link(from account: XAccount) -> TakeLink {
        TakeLink(claim: claim, risk: risk,
                 source: TakeSource(url: url, label: "@\(account.username) on X", kind: "x"))
    }
}

/// Why copying an account didn't work, in words.
struct CopyXError: LocalizedError {
    let message: String

    init(_ error: SocialAPIError, handle: String) {
        let name = "@" + handle.trimmingCharacters(in: CharacterSet(charactersIn: "@ "))
        switch error {
        case .notFound: message = "No recent posts from \(name). Check the handle, or try an account that posts more."
        case .invalid: message = "That isn't an X handle. Type it like @KobeissiLetter."
        case .offline: message = "You're offline."
        case .server(503): message = "Copying X accounts isn't switched on yet."
        default: message = "Couldn't copy \(name). Try again."
        }
    }

    var errorDescription: String? { message }
}

/// Fetches an article page on the phone (a home or cell connection, which news sites let through
/// where they block servers), trimmed to what the server reads: no scripts, styles or SVGs.
enum PageReader {
    static func html(_ url: URL) async -> String? {
        let host = url.host()?.lowercased() ?? ""
        // X posts are read through X's own embed endpoint on the server.
        if host == "x.com" || host.hasSuffix(".x.com") || host.hasSuffix("twitter.com") { return nil }
        var request = URLRequest(url: url, timeoutInterval: 6)
        request.setValue("text/html,application/xhtml+xml", forHTTPHeaderField: "accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              (http.value(forHTTPHeaderField: "content-type") ?? "").contains("html") else { return nil }
        let page = String(decoding: data.prefix(3_000_000), as: UTF8.self)
        let trimmed = page
            .replacing(#/(?is)<(script|style|svg|noscript)\b.*?</\1>/#, with: " ")
            .replacing(#/(?s)<!--.*?-->/#, with: "")
        return String(trimmed.prefix(600_000))
    }
}
