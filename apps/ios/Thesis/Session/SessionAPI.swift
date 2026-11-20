import Foundation

/// The signed-in user as the backend sees them (`session` edge function).
struct SessionSnapshot: Codable, Equatable {
    var profile: RemoteProfile
    var account: RemoteAccount
    var needsOnboarding: Bool
}

struct RemoteProfile: Codable, Equatable {
    let id: String
    var handle: String?
    var displayName: String?
    /// `face:<name>:<color>`, an https photo URL, or `asset:<name>` (demo).
    var avatarUrl: String?

    var hasAvatar: Bool { avatarUrl != nil }
}

struct RemoteAccount: Codable, Equatable {
    var country: String?
    var usState: String?
}

/// Onboarding fields. `nil` fields are left out of the request and unchanged.
struct SessionUpdate: Encodable {
    var handle: String?
    var displayName: String?
    var country: String?
    var usState: String?
    /// A built-in face (`face:<name>:<color>`). Photos are uploaded separately.
    var avatar: String?
}

enum SessionAPIError: LocalizedError, Equatable {
    case handleTaken
    case invalid(String)
    case unauthorized
    case server(Int)
    case offline

    var errorDescription: String? {
        switch self {
        case .handleTaken: "That handle is taken."
        case .invalid(let code) where code == "image_too_large": "That photo is too big. Try another one."
        case .invalid: "Something in there doesn't look right."
        case .unauthorized: "Your session ended. Sign in again."
        case .server: "Something went wrong on our end. Try again."
        case .offline: "You're offline. Check your connection and try again."
        }
    }
}

/// Talks to the `session` edge function (and reads public profiles for
/// handle availability). Auth is the Privy access token, sent as `privy-token`.
struct SessionAPI: Sendable {
    var baseURL: URL = AppConfig.supabaseURL
    var publishableKey: String = AppConfig.supabasePublishableKey

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()

    func fetch(token: String) async throws -> SessionSnapshot {
        try await send("GET", token: token, body: nil)
    }

    func update(_ update: SessionUpdate, token: String) async throws -> SessionSnapshot {
        try await send("PATCH", token: token, body: try Self.encoder.encode(update))
    }

    /// Wipes the profile back to "just signed up". The server only allows this
    /// for Privy test accounts (the debug dev login).
    func resetTestAccount(token: String) async throws -> SessionSnapshot {
        try await send("PATCH", token: token, body: Data(#"{"reset":true}"#.utf8))
    }

    /// Deletes the account for good (profile, takes, comments, follows, cash,
    /// photo, and the Privy login). See the `session` function's DELETE.
    func deleteAccount(token: String) async throws {
        var request = URLRequest(url: baseURL.appending(path: "functions/v1/session"))
        request.httpMethod = "DELETE"
        request.setValue(token, forHTTPHeaderField: "privy-token")
        request.setValue(publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = Data(#"{"confirm":"delete"}"#.utf8)
        let (_, response) = try await load(request)
        switch response.statusCode {
        case 200: return
        case 401: throw SessionAPIError.unauthorized
        default: throw SessionAPIError.server(response.statusCode)
        }
    }

    /// Uploads a profile photo (JPEG). Replaces any icon avatar.
    func uploadAvatar(jpeg: Data, token: String) async throws -> SessionSnapshot {
        try await send("POST", token: token, body: jpeg, contentType: "image/jpeg")
    }

    /// Profiles are world-readable, so this needs no token.
    func isHandleAvailable(_ handle: String) async throws -> Bool {
        var components = URLComponents(url: baseURL.appending(path: "rest/v1/profiles"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "select", value: "id"),
            URLQueryItem(name: "handle", value: "eq.\(handle)"),
            URLQueryItem(name: "limit", value: "1"),
        ]
        var request = URLRequest(url: components.url!)
        request.setValue(publishableKey, forHTTPHeaderField: "apikey")
        let (data, response) = try await load(request)
        guard response.statusCode == 200 else { throw SessionAPIError.server(response.statusCode) }
        struct Row: Decodable { let id: String }
        return try Self.decoder.decode([Row].self, from: data).isEmpty
    }

    private func send(_ method: String, token: String, body: Data?, contentType: String = "application/json") async throws -> SessionSnapshot {
        var request = URLRequest(url: baseURL.appending(path: "functions/v1/session"))
        request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "privy-token")
        request.setValue(publishableKey, forHTTPHeaderField: "apikey")
        if let body {
            request.setValue(contentType, forHTTPHeaderField: "content-type")
            request.httpBody = body
        }
        let (data, response) = try await load(request)
        switch response.statusCode {
        case 200:
            return try Self.decoder.decode(SessionSnapshot.self, from: data)
        case 401:
            throw SessionAPIError.unauthorized
        case 409:
            throw SessionAPIError.handleTaken
        case 400, 413, 415:
            struct Failure: Decodable { let error: String }
            let code = (try? Self.decoder.decode(Failure.self, from: data).error) ?? "invalid"
            throw SessionAPIError.invalid(code)
        default:
            throw SessionAPIError.server(response.statusCode)
        }
    }

    private func load(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw SessionAPIError.server(-1) }
            return (data, http)
        } catch is URLError {
            throw SessionAPIError.offline
        }
    }
}
