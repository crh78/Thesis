import PhotosUI
import SwiftUI

/// Pick a profile photo: one of the built-in faces (any color, or shuffled),
/// or a photo from the library. Used as an onboarding step and from
/// Me → Edit profile.
struct AvatarPickerView: View {
    enum Mode { case onboarding, edit }

    let mode: Mode
    let save: (AvatarSelection) async throws -> Void
    var onDone: () -> Void = {}

    private let current: RemoteProfile?
    @State private var icon: String
    @State private var color: Int
    @State private var keepCurrentPhoto: Bool
    @State private var photo: UIImage?
    @State private var photoJPEG: Data?
    @State private var pickerItem: PhotosPickerItem?
    @State private var loadingPhoto = false
    /// nil = All.
    @State private var look: AvatarIcons.Look?
    @State private var busy = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    /// - Parameters:
    ///   - current: the profile as it is now (prefills the picker).
    ///   - seed: used for the default icon when there's no profile yet.
    init(mode: Mode, current: RemoteProfile?, seed: String,
         save: @escaping (AvatarSelection) async throws -> Void, onDone: @escaping () -> Void = {}) {
        self.mode = mode
        self.save = save
        self.onDone = onDone
        self.current = current
        // Same default as `Person.avatar`, so the picker opens on the face you already show.
        let face = current?.avatarUrl.flatMap(AvatarFace.parse) ?? AvatarIcons.defaultChoice(for: current?.handle ?? seed)
        _icon = State(initialValue: face.name)
        _color = State(initialValue: face.color)
        let hasPhoto = current?.avatarUrl.map { AvatarFace.parse($0) == nil } ?? false
        _keepCurrentPhoto = State(initialValue: mode == .edit && hasPhoto)
    }

    private var selection: AvatarSelection {
        if let photoJPEG { return .photo(jpeg: photoJPEG) }
        if keepCurrentPhoto { return .unchanged }
        return .face(icon, color: color)
    }

    var body: some View {
        OnboardingScaffold(title: mode == .onboarding ? "Pick a profile photo" : "Profile photo",
                           subtitle: "Pick a face or upload your own. You can change it anytime.") {
            VStack(spacing: 24) {
                preview
                    .frame(maxWidth: .infinity)
                    .animation(.snappy, value: icon)
                    .animation(.snappy, value: color)

                colorRow
                actions
                InlineError(text: error)

                Picker("Show", selection: $look) {
                    Text("All").tag(AvatarIcons.Look?.none)
                    ForEach(AvatarIcons.Look.allCases, id: \.self) { Text($0.rawValue).tag(Optional($0)) }
                }
                .pickerStyle(.segmented)

                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4), spacing: 14) {
                    ForEach(AvatarIcons.faces(look), id: \.name) { item in
                        iconButton(item.name)
                    }
                }
                .animation(.snappy, value: look)
                .padding(.bottom, 12)
            }
        } footer: {
            OnboardingButton(title: mode == .onboarding ? "Continue" : "Save", busy: busy, action: submit)
                .disabled(busy || loadingPhoto)
        }
        .toolbar {
            if mode == .edit {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            loadPhoto(item)
        }
        .navigationBarBackButtonHidden(mode == .onboarding)
    }

    // MARK: Pieces

    @ViewBuilder private var preview: some View {
        let size: CGFloat = 132
        ZStack {
            if let photo {
                Image(uiImage: photo).resizable().scaledToFill()
                    .frame(width: size, height: size).clipShape(Circle())
            } else if keepCurrentPhoto, let url = current?.avatarUrl {
                Avatar(name: url.hasPrefix("asset:") ? String(url.dropFirst(6)) : url, size: size)
            } else {
                IconAvatar(icon: icon, color: color, size: size)
            }
            if loadingPhoto {
                Circle().fill(.black.opacity(0.35)).frame(width: size, height: size)
                ProgressView().tint(.white)
            }
        }
        .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: 1))
        .accessibilityElement()
        .accessibilityLabel(photo != nil || keepCurrentPhoto ? "Your photo" : "Avatar \(Int(icon.dropFirst(7)) ?? 0)")
        .accessibilityIdentifier("avatar-preview")
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button {
                shuffle()
            } label: {
                Label("Shuffle", systemImage: "dice")
                    .font(.geist(15, .semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.glass)

            PhotosPicker(selection: $pickerItem, matching: .images) {
                Label("Upload photo", systemImage: "photo.on.rectangle")
                    .font(.geist(15, .semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.glass)
        }
        .foregroundStyle(Palette.text)
    }

    private func iconButton(_ name: String) -> some View {
        let selected = photoJPEG == nil && !keepCurrentPhoto && name == icon
        return Button {
            withAnimation(.snappy) { useIcon(name, color: color) }
        } label: {
            IconAvatar(icon: name, color: color, size: 64)
                .overlay(Circle().strokeBorder(selected ? Palette.text : .clear, lineWidth: 3).padding(-5))
                .frame(maxWidth: .infinity, minHeight: 74)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Avatar \(Int(name.dropFirst(7)) ?? 0)")
        .accessibilityIdentifier("avatar-option-\(name)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var colorRow: some View {
        HStack(spacing: 0) {
            ForEach(AvatarIcons.colors.indices, id: \.self) { i in
                let selected = photoJPEG == nil && !keepCurrentPhoto && i == color
                Button {
                    withAnimation(.snappy) { useIcon(icon, color: i) }
                } label: {
                    Circle()
                        .fill(AvatarIcons.color(i))
                        .frame(width: 28, height: 28)
                        .overlay(Circle().strokeBorder(selected ? Palette.text : .clear, lineWidth: 2.5).padding(-4))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Color \(i + 1)")
                .accessibilityIdentifier("avatar-color-\(i)")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }

    // MARK: Actions

    private func useIcon(_ name: String, color: Int) {
        icon = name
        self.color = color
        photo = nil
        photoJPEG = nil
        keepCurrentPhoto = false
        pickerItem = nil
        error = nil
    }

    /// Shuffles within the current filter.
    private func shuffle() {
        let pool = AvatarIcons.faces(look).map(\.name)
        var next = pool.randomElement()!
        while next == icon, pool.count > 1 { next = pool.randomElement()! }
        withAnimation(.snappy) { useIcon(next, color: Int.random(in: 0..<AvatarIcons.colors.count)) }
    }

    private func loadPhoto(_ item: PhotosPickerItem) {
        error = nil
        loadingPhoto = true
        Task {
            defer { loadingPhoto = false }
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data),
                  let jpeg = Self.squareJPEG(image) else {
                error = "Couldn't open that photo. Try another one."
                return
            }
            photo = UIImage(data: jpeg)
            photoJPEG = jpeg
            keepCurrentPhoto = false
        }
    }

    private func submit() {
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await save(selection)
                onDone()
            } catch {
                self.error = AuthErrorText.message(for: error)
            }
        }
    }

    /// Center-crops to a square and scales to `side` px: small enough to upload
    /// quickly, sharp enough for the largest avatar (132pt @3x ≈ 400px).
    static func squareJPEG(_ image: UIImage, side: CGFloat = 640) -> Data? {
        let w = image.size.width, h = image.size.height
        let s = min(w, h)
        guard s > 0 else { return nil }
        let scale = side / s
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let rendered = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            image.draw(in: CGRect(x: -(w - s) / 2 * scale, y: -(h - s) / 2 * scale, width: w * scale, height: h * scale))
        }
        return rendered.jpegData(compressionQuality: 0.85)
    }
}
