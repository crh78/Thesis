import SwiftUI

/// Edit your photo, name, @handle and bio.
///
/// Signed in: name and handle save through the session (`SessionStore.saveProfile`,
/// which owns the signed-in profile), the photo through the face/photo picker
/// (`saveAvatar`), and the bio through the social layer. In mock mode it all
/// changes locally.
struct EditProfileView: View {
    @Environment(AppState.self) private var app
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var handle = ""
    @State private var bio = ""
    @State private var choosingPhoto = false
    @State private var status: HandleStatus = .yours
    @State private var saving = false
    @State private var error: String?
    @State private var loaded = false

    private static let bioLimit = 160

    enum HandleStatus: Equatable { case yours, tooShort, checking, available, taken, unknown }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedBio: String { bio.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var nameOrHandleChanged: Bool { trimmedName != app.me.name || handle != app.me.id }
    private var bioChanged: Bool { trimmedBio != app.me.bio }
    private var valid: Bool {
        !trimmedName.isEmpty && trimmedName.count <= 50
            && handle.count >= 3 && status != .taken && status != .checking
            && bio.count <= Self.bioLimit
    }
    private var canSave: Bool { (nameOrHandleChanged || bioChanged) && valid && !saving }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    photoSection
                    VStack(alignment: .leading, spacing: 26) {
                        field("Name") {
                            UnderlineField(placeholder: "Your name", text: $name, font: .geist(18, .medium))
                                .textContentType(.name)
                                .accessibilityIdentifier("edit-name")
                        }
                        field("Handle") {
                            UnderlineField(placeholder: "handle", text: $handle, prefix: "@", font: .geist(18, .medium))
                                .textContentType(.username)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .accessibilityIdentifier("edit-handle")
                            handleStatus
                        }
                        field("Bio") {
                            VStack(spacing: 10) {
                                TextField("A line about what you call", text: $bio, axis: .vertical)
                                    .font(.geist(17))
                                    .lineLimit(2...5)
                                    // Bios are often all lowercase: don't force a capital.
                                    .textInputAutocapitalization(.never)
                                    .accessibilityIdentifier("edit-bio")
                                Hairline()
                            }
                            Text("\(bio.count)/\(Self.bioLimit)")
                                .font(.mono(11))
                                .foregroundStyle(bio.count > Self.bioLimit ? Palette.down : Palette.muted)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        InlineError(text: error)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(ThesisBackground())
            .navigationTitle("Edit profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save", action: save)
                            .fontWeight(.semibold)
                            .disabled(!canSave)
                    }
                }
            }
            .sheet(isPresented: $choosingPhoto) {
                NavigationStack {
                    AvatarPickerView(mode: .edit, current: session.snapshot?.profile,
                                     seed: session.snapshot?.profile.id ?? app.me.id,
                                     save: savePhoto, onDone: { choosingPhoto = false })
                }
            }
        }
        .interactiveDismissDisabled(saving || nameOrHandleChanged || bioChanged)
        .onAppear {
            guard !loaded else { return }
            loaded = true
            name = app.me.name
            handle = app.me.id
            bio = app.me.bio
        }
        .onChange(of: handle) { _, new in
            let clean = ProfileSetupView.sanitize(new)
            if clean != new { handle = clean }
        }
        .onChange(of: bio) { _, new in
            if new.count > Self.bioLimit { bio = String(new.prefix(Self.bioLimit)) }
        }
        .task(id: handle) { await check(handle) }
        .animation(.snappy, value: status)
        .animation(.snappy, value: error)
    }

    // MARK: Photo

    /// The photo saves on its own, from the picker (it has its own Done).
    private var photoSection: some View {
        Button { choosingPhoto = true } label: {
            VStack(spacing: 10) {
                Avatar(name: app.me.avatar, size: 96)
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Palette.bg)
                            .frame(width: 30, height: 30)
                            .background(Palette.text, in: Circle())
                            .overlay(Circle().stroke(Palette.bg, lineWidth: 3))
                    }
                Text("Change photo")
                    .font(.geist(14, .semibold))
                    .foregroundStyle(Palette.text)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Change photo")
    }

    private func savePhoto(_ selection: AvatarSelection) async throws {
        if app.isLive {
            try await session.saveAvatar(selection)
            app.profileChanged()
        } else {
            app.editMockProfile(name: app.me.name, handle: app.me.id, bio: app.me.bio, avatar: selection)
        }
    }

    // MARK: Handle

    @ViewBuilder private var handleStatus: some View {
        let (text, color): (String, Color) = switch status {
        case .yours: ("Letters, numbers and underscores.", Palette.muted)
        case .tooShort: ("At least 3 characters.", Palette.muted)
        case .checking: ("Checking…", Palette.muted)
        case .available: ("@\(handle) is available", Palette.up)
        case .taken: ("@\(handle) is taken", Palette.down)
        case .unknown: ("Couldn't check. We'll check when you save.", Palette.muted)
        }
        Text(text)
            .font(.geist(13))
            .foregroundStyle(color)
            .accessibilityIdentifier("edit-handle-status")
    }

    private func check(_ candidate: String) async {
        if candidate == app.me.id {
            status = .yours
            return
        }
        guard candidate.count >= 3 else {
            status = .tooShort
            return
        }
        status = .checking
        try? await Task.sleep(for: .milliseconds(350))
        guard !Task.isCancelled else { return }
        let available: Bool? = app.isLive
            ? await session.isHandleAvailable(candidate)
            : candidate != "taken"
        guard !Task.isCancelled else { return }
        switch available {
        case true?: status = .available
        case false?: status = .taken
        case nil: status = .unknown
        }
    }

    // MARK: Save

    /// Name and handle first: if the handle turns out to be taken, nothing else saves.
    private func save() {
        guard canSave else { return }
        saving = true
        error = nil
        Task {
            defer { saving = false }
            do {
                if app.isLive {
                    if nameOrHandleChanged { try await session.saveProfile(name: trimmedName, handle: handle) }
                    if bioChanged { try await app.saveBio(trimmedBio) }
                    app.profileChanged()
                } else {
                    app.editMockProfile(name: trimmedName, handle: handle, bio: trimmedBio, avatar: .unchanged)
                }
                dismiss()
            } catch SessionAPIError.handleTaken {
                status = .taken
            } catch {
                self.error = AuthErrorText.message(for: error)
                    ?? (error as? LocalizedError)?.errorDescription
                    ?? "Couldn't save. Try again."
            }
        }
    }

    private func field<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased()).font(.mono(11)).foregroundStyle(Palette.muted)
            content()
        }
    }
}
