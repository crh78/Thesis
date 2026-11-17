import Foundation

/// Your bio (the `social` edge function's PATCH /profile). Name, handle and photo
/// go through the session (`SessionStore.saveProfile` / `saveAvatar`), which owns
/// the signed-in profile; the session function doesn't store bios.
extension SocialAPI {
    /// An empty bio clears it. Returns your updated profile.
    func updateBio(_ bio: String) async throws -> Person {
        struct Body: Encodable { let bio: String }
        struct Result: Decodable { let profile: PersonDTO }
        let data = try await call("PATCH", "profile", body: try Self.encoder.encode(Body(bio: bio)))
        return try Self.decoder.decode(Result.self, from: data).profile.person
    }

    /// Who can see your follow lists. Returns what the server saved.
    func updatePrivacy(_ privacy: FollowPrivacy) async throws -> FollowPrivacy {
        struct Body: Encodable { let showFollowing: Bool; let showFollowers: Bool }
        struct Result: Decodable { let profile: PersonDTO }
        let body = try Self.encoder.encode(Body(showFollowing: privacy.showFollowing, showFollowers: privacy.showFollowers))
        let data = try await call("PATCH", "profile", body: body)
        return try Self.decoder.decode(Result.self, from: data).profile.privacy
    }

    /// Removes someone from your followers. They can follow you again.
    func removeFollower(_ profileID: String) async throws {
        _ = try await call("DELETE", "followers/\(profileID)")
    }
}
