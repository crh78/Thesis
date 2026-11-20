import CoreImage.CIFilterBuiltins
import LinkPresentation
import SwiftUI

/// What a "called it" card shows: one of your positions and how it's done.
struct CallCard: Hashable, Identifiable {
    var id: String { takeID + (faded ? ":fade" : ":back") }
    let takeID: String
    let claim: String
    /// Your return on the position, in percent.
    let ret: Double
    let faded: Bool
    /// The take's author (without @), when it isn't you.
    let author: String?
    let name: String
    let handle: String
    let avatar: String
    /// "Dec 4": when the take was posted, if known.
    let since: String?
    /// The take's basket, for the Basket look (empty if the take isn't loaded).
    var legs: [Leg] = []
    /// The take bets against its basket: agreeing with it (Traded) is short the picks.
    var inverted = false

    /// Up enough to brag about (same 1% line as the web's called-it page).
    var called: Bool { ret >= 1 }
    var pct: String { Fmt.pct(ret) }
    var sideWord: String { faded ? "Faded" : "Traded" }
    /// Short the basket's picks: a fade, or agreeing with a take that bets against them.
    var isShort: Bool { faded != inverted }
    /// "@handle", or just the name when there's no handle (a deleted account's take).
    var byline: String { handle.isEmpty ? name : "@\(handle)" }
    /// "@mo_fades's take", or nil when it's your own.
    var whose: String? {
        guard let author, author.lowercased() != handle.lowercased() else { return nil }
        return "@\(author)'s take"
    }
}

/// The looks you swipe through, like camera filters.
enum CardTheme: String, CaseIterable, Identifiable {
    case glow, basket, receipt, terminal, gold, holo, press
    var id: String { rawValue }

    /// The looks a card can use: Basket needs the take's basket.
    static func available(for card: CallCard) -> [CardTheme] {
        card.legs.isEmpty ? allCases.filter { $0 != .basket } : allCases
    }

    var name: String {
        switch self {
        case .glow: "Glow"
        case .basket: "Basket"
        case .receipt: "Receipt"
        case .terminal: "Terminal"
        case .gold: "Gold"
        case .holo: "Holo"
        case .press: "Front page"
        }
    }

    @ViewBuilder var swatch: some View {
        switch self {
        case .glow: RadialGradient(colors: [Color(hex: 0xA6E3B8), Color(hex: 0x1B3A2A), Color(hex: 0x0B0D12)], center: .init(x: 0.7, y: 0.75), startRadius: 0, endRadius: 30)
        case .basket: AngularGradient(colors: [Palette.series(0), Palette.series(1), Palette.series(2), Palette.series(3), Palette.series(0)], center: .center)
        case .receipt: Color(hex: 0xF5F1E8).overlay(Barcode(seed: "swatch", bars: 10).padding(9))
        case .terminal: Color(hex: 0x050505).overlay(Circle().strokeBorder(Color(hex: 0xFFB000), lineWidth: 2.5))
        case .gold: LinearGradient(colors: [Color(hex: 0xFFF1C1), Color(hex: 0xE8C878), Color(hex: 0x8A6420)], startPoint: .topLeading, endPoint: .bottomTrailing)
        case .holo: Holo.gradient
        case .press: Color(hex: 0xEFE8D8)
        }
    }
}

// MARK: - The sheet

/// Tap share on a position: swipe to a look, tap Share. Just the picture goes out, no text or link.
struct CalledItShareSheet: View {
    let card: CallCard
    @Environment(\.dismiss) private var dismiss
    @Environment(\.displayScale) private var displayScale
    @Environment(SessionStore.self) private var session
    @State private var linking = false
    @State private var linkError: String?
    /// Links already made, one per look, so tapping Share again doesn't upload again.
    @State private var links: [CardTheme: URL] = [:]
    @State private var theme: CardTheme = .glow
    @State private var photo: UIImage?
    @State private var rendered: [CardTheme: UIImage] = [:]

    /// Cards are laid out at 9:16 (a full phone screen, like a Story) and saved at 1080×1920.
    private let cardSize = CGSize(width: 360, height: 640)
    private let previewScale: CGFloat = 0.8

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(card.called ? "Called it" : "Share your position")
                    .font(.geist(17, .semibold))
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .frame(width: 32, height: 32)
                        .background(Palette.tile, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)

            TabView(selection: $theme) {
                ForEach(CardTheme.available(for: card)) { t in
                    ThemedCard(card: card, theme: t, photo: photo)
                        .frame(width: cardSize.width, height: cardSize.height)
                        .scaleEffect(previewScale)
                        .frame(width: cardSize.width * previewScale, height: cardSize.height * previewScale)
                        .shadow(color: .black.opacity(0.5), radius: 24, y: 14)
                        .tag(t)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .frame(height: cardSize.height * previewScale + 28)
            .padding(.top, 2)

            Text(theme.name.uppercased())
                .font(.mono(12))
                .tracking(1.5)
                .foregroundStyle(Palette.text)
            HStack(spacing: 12) {
                ForEach(CardTheme.available(for: card)) { t in
                    Button { withAnimation(.snappy) { theme = t } } label: {
                        t.swatch
                            .frame(width: 36, height: 36)
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(.white.opacity(0.18), lineWidth: 1.5))
                            .padding(3)
                            .overlay(Circle().strokeBorder(theme == t ? Palette.text : .clear, lineWidth: 2))
                            .scaleEffect(theme == t ? 1.1 : 1)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(t.name)
                }
            }
            .padding(.top, 10)
            .sensoryFeedback(.selection, trigger: theme)

            Spacer(minLength: 12)

            if let linkError {
                Text(linkError).font(.geist(13)).foregroundStyle(Palette.down).padding(.bottom, 8)
            }
            if let image = rendered[theme] {
                HStack(spacing: 10) {
                    // The link: iMessage shows this exact card as its preview, and tapping it opens the take.
                    Button { Task { await shareLink(image) } } label: {
                        HStack(spacing: 8) {
                            if linking { ProgressView().tint(Palette.bg) } else { Image(systemName: "square.and.arrow.up") }
                            Text("Share")
                        }
                        .font(.geist(17, .semibold))
                        .foregroundStyle(Palette.bg)
                        .frame(maxWidth: .infinity, minHeight: 54)
                        .background(Palette.text, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(linking)
                    .accessibilityIdentifier("calledIt.share")
                    // Just the picture, no link.
                    ShareLink(item: Image(uiImage: image), preview: SharePreview("Thesis", image: Image(uiImage: image))) {
                        Image(systemName: "photo")
                            .font(.system(size: 19, weight: .semibold))
                            .foregroundStyle(Palette.text)
                            .frame(width: 54, height: 54)
                            .background(Palette.tile, in: Circle())
                            .overlay(Circle().strokeBorder(.white.opacity(0.12)))
                    }
                    .accessibilityLabel("Send as a photo")
                    .accessibilityIdentifier("calledIt.photo")
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 12)
            } else {
                ProgressView().frame(height: 54).padding(.bottom, 12)
            }
        }
        .background(ThesisBackground())
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .task { await prepare() }
        .onChange(of: theme) { render(theme) }
    }

    /// Uploads this look's picture (once), then shares the link that previews as it.
    private func shareLink(_ image: UIImage) async {
        linkError = nil
        if let url = links[theme] { return present(url, image) }
        guard let jpeg = image.jpegData(compressionQuality: 0.85) else { return }
        linking = true
        defer { linking = false }
        do {
            let token = try await session.accessToken()
            let id = try await CardsAPI.upload(jpeg, take: card.takeID, token: token)
            var c = URLComponents(url: AppConfig.webURL.appending(path: "c/\(card.takeID)"), resolvingAgainstBaseURL: false)!
            c.queryItems = [URLQueryItem(name: "card", value: id)]
            guard let url = c.url else { return }
            links[theme] = url
            present(url, image)
        } catch {
            linkError = "Couldn't make the link. Send it as a photo instead."
        }
    }

    private func present(_ url: URL, _ image: UIImage) {
        let item = CardLinkItem(url: url, image: image, title: card.called ? "Called it: \(card.claim)" : card.claim)
        let vc = UIActivityViewController(activityItems: [item], applicationActivities: nil)
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }),
              var top = scene.keyWindow?.rootViewController else { return }
        while let next = top.presentedViewController { top = next }
        vc.popoverPresentationController?.sourceView = top.view
        top.present(vc, animated: true)
    }

    /// A photo avatar has to be loaded before it can be drawn into the picture.
    private func prepare() async {
        if card.avatar.hasPrefix("https://"), let url = URL(string: card.avatar),
           let (data, _) = try? await URLSession.shared.data(from: url) {
            photo = UIImage(data: data)
        }
        render(theme)
    }

    private func render(_ t: CardTheme) {
        guard rendered[t] == nil else { return }
        // Square corners in the saved picture: it fills the screen when opened.
        let renderer = ImageRenderer(content: ThemedCard(card: card, theme: t, photo: photo)
            .frame(width: cardSize.width, height: cardSize.height)
            .environment(\.cardCorner, 0)
            .background(Color(hex: 0x0B0D12))
            .environment(\.colorScheme, .dark))
        renderer.scale = max(displayScale, 3)
        if let image = renderer.uiImage { rendered[t] = image }
    }
}

/// functions/v1/cards: stores a card picture so its link can preview as it.
private enum CardsAPI {
    struct Uploaded: Decodable { let card: String }

    static func upload(_ jpeg: Data, take: String, token: String) async throws -> String {
        var c = URLComponents(url: AppConfig.supabaseURL.appending(path: "functions/v1/cards"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "take", value: take)]
        var request = URLRequest(url: c.url!)
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "privy-token")
        request.setValue(AppConfig.supabasePublishableKey, forHTTPHeaderField: "apikey")
        request.setValue("image/jpeg", forHTTPHeaderField: "content-type")
        request.httpBody = jpeg
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(Uploaded.self, from: data).card
    }
}

/// The shared link, with the card itself as its preview in the share sheet and in Messages.
private final class CardLinkItem: NSObject, UIActivityItemSource {
    let url: URL
    let image: UIImage
    let title: String

    init(url: URL, image: UIImage, title: String) {
        self.url = url
        self.image = image
        self.title = title
    }

    func activityViewControllerPlaceholderItem(_ controller: UIActivityViewController) -> Any { url }

    func activityViewController(_ controller: UIActivityViewController, itemForActivityType type: UIActivity.ActivityType?) -> Any? { url }

    func activityViewControllerLinkMetadata(_ controller: UIActivityViewController) -> LPLinkMetadata? {
        let meta = LPLinkMetadata()
        meta.originalURL = url
        meta.url = url
        meta.title = title
        meta.imageProvider = NSItemProvider(object: image)
        return meta
    }
}

// MARK: - Cards

struct ThemedCard: View {
    let card: CallCard
    let theme: CardTheme
    var photo: UIImage?

    var body: some View {
        switch theme {
        case .glow: GlowCard(c: card, photo: photo)
        case .basket: BasketCard(c: card, photo: photo)
        case .receipt: ReceiptCard(c: card)
        case .terminal: TerminalCard(c: card)
        case .gold: GoldCard(c: card, photo: photo)
        case .holo: HoloCard(c: card, photo: photo)
        case .press: PressCard(c: card)
        }
    }
}

private struct Face: View {
    let c: CallCard
    let photo: UIImage?
    let size: CGFloat

    var body: some View {
        if let photo {
            Image(uiImage: photo).resizable().scaledToFill().frame(width: size, height: size).clipShape(Circle())
        } else {
            Avatar(name: c.avatar, size: size)
        }
    }
}

extension EnvironmentValues {
    /// The card's corner radius: rounded in the sheet, square in the saved picture.
    @Entry var cardCorner: CGFloat = 26
}

/// A QR code for a link, drawn crisp at any size.
private enum CardQR {
    static func image(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let out = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// The card's link, embedded: a QR code that opens the take, so the picture is all you send.
private struct ScanTag: View {
    let c: CallCard
    var ink: Color = .white

    var body: some View {
        HStack(spacing: 12) {
            if let qr = CardQR.image(AppConfig.takeURL(c.takeID).absoluteString) {
                Image(uiImage: qr)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 58, height: 58)
                    .padding(5)
                    .background(.white, in: RoundedRectangle(cornerRadius: 8))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("SCAN TO TRADE IT").font(.mono(12, .medium)).tracking(1)
                Text("on thesis").font(.geist(13)).opacity(0.65)
            }
            .foregroundStyle(ink)
            Spacer(minLength: 0)
        }
    }
}

/// Smaller type for longer claims.
private func claimSize(_ s: String, _ big: CGFloat, _ small: CGFloat) -> CGFloat {
    s.count > 90 ? small : s.count > 50 ? (big + small) / 2 : big
}

private struct GlowCard: View {
    let c: CallCard
    @Environment(\.cardCorner) private var corner
    let photo: UIImage?
    private let up = Color(hex: 0xA6E3B8)
    private let down = Color(hex: 0xF2A9C2)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(c.called ? "✓ CALLED IT" : "MY POSITION")
                    .font(.mono(14, .medium))
                    .padding(.horizontal, 13).padding(.vertical, 7)
                    .background(c.called ? up : .white.opacity(0.1), in: Capsule())
                    .foregroundStyle(c.called ? Color(hex: 0x06210F) : Palette.muted)
                Spacer()
                if let since = c.since { Text("SINCE \(since.uppercased())").font(.mono(13)).opacity(0.6) }
            }
            Text(c.claim)
                .font(.serif(claimSize(c.claim, 40, 29)))
                .lineSpacing(-2)
                .minimumScaleFactor(0.6)
                .padding(.top, 26)
            Spacer(minLength: 8)
            Text(c.pct)
                .font(.geist(100, .semibold))
                .tracking(-3)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .foregroundStyle(c.ret >= 0 ? up : down)
                .shadow(color: c.ret >= 0 ? up.opacity(0.5) : .clear, radius: 18)
            Text("\(c.sideWord.uppercased())\(c.whose.map { " · \($0.uppercased())" } ?? "")")
                .font(.mono(13)).opacity(0.6).padding(.top, 8)
            Spacer(minLength: 8)
            HStack(spacing: 10) {
                Face(c: c, photo: photo, size: 38)
                Text(c.name).font(.geist(18, .semibold))
                Spacer()
                Text("thesis").font(.mono(18)).opacity(0.7)
            }
            Rectangle().fill(.white.opacity(0.1)).frame(height: 1).padding(.vertical, 16)
            ScanTag(c: c)
        }
        .padding(28)
        .foregroundStyle(Color(hex: 0xF2F3F5))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            ZStack {
                Color(hex: 0x0B0D12)
                RadialGradient(colors: [Color(hex: 0x8296FF).opacity(0.28), .clear], center: .topLeading, startRadius: 0, endRadius: 260)
                if c.called {
                    RadialGradient(colors: [up.opacity(0.42), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 320)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: corner))
        .overlay(RoundedRectangle(cornerRadius: corner).strokeBorder(c.called ? up.opacity(0.3) : .white.opacity(0.09)).opacity(corner > 0 ? 1 : 0))
    }
}

/// The take's basket as a ring, your return in the middle, and its main picks in plain words.
private struct BasketCard: View {
    let c: CallCard
    @Environment(\.cardCorner) private var corner
    let photo: UIImage?
    private let up = Color(hex: 0xA6E3B8)
    private let down = Color(hex: 0xF2A9C2)

    private var legs: [Leg] { c.legs.sorted { $0.weight > $1.weight } }
    private var total: Double { max(1, c.legs.reduce(0) { $0 + $1.weight }) }

    /// "Gold on Dec 18?: $3,975 or above" → "Gold on Dec 18"; long names get cut.
    private func plain(_ name: String) -> String {
        var s = name
        if let r = s.range(of: "?:") { s = String(s[..<r.lowerBound]) }
        s = s.replacingOccurrences(of: "?", with: "")
        for tail in [" Technology", " Technologies", " Corporation", " Corp.", " Corp", " Inc.", " Inc", " Holdings", " Platforms"] where s.hasSuffix(tail) {
            s = String(s.dropLast(tail.count))
        }
        return s.count > 22 ? String(s.prefix(21)) + "…" : s
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(c.called ? "✓ CALLED IT" : "MY POSITION")
                    .font(.mono(14, .medium))
                    .padding(.horizontal, 13).padding(.vertical, 7)
                    .background(c.called ? up : .white.opacity(0.1), in: Capsule())
                    .foregroundStyle(c.called ? Color(hex: 0x06210F) : Palette.muted)
                Spacer()
                // The picks below are the basket; on a take against them, say which way you hold them.
                Text(c.sideWord.uppercased() + (c.inverted ? (c.isShort ? " · SHORT" : " · LONG") : ""))
                    .font(.mono(13)).opacity(0.6)
            }
            Text(c.claim)
                .font(.serif(claimSize(c.claim, 30, 23)))
                .lineLimit(4)
                .minimumScaleFactor(0.7)
                .padding(.top, 18)
            Spacer(minLength: 10)
            ZStack {
                BasketDonut(legs: legs, innerRatio: 0.7)
                VStack(spacing: 2) {
                    Text(c.pct)
                        .font(.geist(42, .semibold)).tracking(-1.5)
                        .minimumScaleFactor(0.6).lineLimit(1)
                        .foregroundStyle(c.ret >= 0 ? up : down)
                    Text("RETURN").font(.mono(11)).tracking(1.5).opacity(0.55)
                }
                .padding(.horizontal, 44)
            }
            .frame(width: 210, height: 210)
            .frame(maxWidth: .infinity)
            Spacer(minLength: 10)
            VStack(alignment: .leading, spacing: 10) {
                ForEach(legs.prefix(4)) { leg in
                    HStack(spacing: 9) {
                        RoundedRectangle(cornerRadius: 3).fill(Palette.series(leg.slot)).frame(width: 12, height: 12)
                        Text(plain(leg.name)).font(.geist(17)).lineLimit(1)
                        Spacer(minLength: 2)
                        Text("\(Int((leg.weight / total * 100).rounded()))%").font(.mono(15)).opacity(0.7)
                    }
                }
                if legs.count > 4 {
                    Text("+\(legs.count - 4) more").font(.mono(13)).opacity(0.55)
                }
            }
            Rectangle().fill(.white.opacity(0.1)).frame(height: 1).padding(.vertical, 16)
            HStack(spacing: 12) {
                ScanTag(c: c)
                Face(c: c, photo: photo, size: 38)
            }
        }
        .padding(28)
        .foregroundStyle(Color(hex: 0xF2F3F5))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            ZStack {
                Color(hex: 0x0B0D12)
                RadialGradient(colors: [Palette.series(0).opacity(0.22), .clear], center: .init(x: 0.2, y: 0.65), startRadius: 0, endRadius: 220)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: corner))
        .overlay(RoundedRectangle(cornerRadius: corner).strokeBorder(.white.opacity(0.09)).opacity(corner > 0 ? 1 : 0))
        .environment(\.colorScheme, .dark)
    }
}

/// A receipt's scalloped top and bottom edges.
private struct Scalloped: Shape {
    var r: CGFloat = 7
    var step: CGFloat = 17

    func path(in rect: CGRect) -> Path {
        var p = Path(rect)
        var x = step / 2
        while x < rect.width {
            p.addEllipse(in: CGRect(x: x - r, y: -r, width: r * 2, height: r * 2))
            p.addEllipse(in: CGRect(x: x - r, y: rect.height - r, width: r * 2, height: r * 2))
            x += step
        }
        return p
    }
}

struct Barcode: View {
    let seed: String
    var bars = 46

    private var widths: [CGFloat] {
        var h: UInt32 = 2_166_136_261
        for u in seed.unicodeScalars { h = (h ^ u.value) &* 16_777_619 }
        return (0..<bars).map { _ in
            h = (h ^ (h >> 13)) &* 1_274_126_177
            return CGFloat(1 + h % 4)
        }
    }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(widths.enumerated()), id: \.offset) { i, w in
                Rectangle().frame(width: w).padding(.trailing, i % 3 == 0 ? 1 : 0)
            }
        }
    }
}

private struct ReceiptCard: View {
    let c: CallCard
    private let ink = Color(hex: 0x1B1A17)
    private let green = Color(hex: 0x1E7A43)

    private func line(_ k: String, _ v: String) -> some View {
        HStack { Text(k); Spacer(); Text(v) }.font(.mono(14)).padding(.vertical, 2)
    }

    private var rule: some View {
        Line().stroke(style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])).frame(height: 1.5).opacity(0.4).padding(.vertical, 14)
    }

    var body: some View {
        VStack(spacing: 0) {
            Text("THESIS").font(.mono(26, .medium)).tracking(8)
            Text("POSITION RECEIPT").font(.mono(12)).tracking(1.5).padding(.top, 2)
            Text("No. \(String(c.takeID.replacingOccurrences(of: "-", with: "").suffix(8)).uppercased())").font(.mono(12)).tracking(1.5)
            rule
            Text(c.claim.uppercased())
                .font(.mono(claimSize(c.claim, 21, 16)))
                .minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity, alignment: .leading)
            rule
            line("CALLED BY", c.byline)
            line("SIDE", c.sideWord.uppercased())
            if let since = c.since { line("SINCE", since.uppercased()) }
            if let author = c.author, c.whose != nil { line("TAKE BY", "@\(author)") }
            rule
            HStack(alignment: .firstTextBaseline) {
                Text("RETURN").font(.mono(16)).tracking(1.5)
                Spacer()
                Text(c.pct).font(.mono(50, .medium)).tracking(-1.5)
            }
            Spacer(minLength: 6)
            Barcode(seed: c.takeID).frame(height: 46)
            Text("THANK YOU FOR TRADING · PLAY MONEY").font(.mono(11)).tracking(1.5).opacity(0.7).padding(.top, 8)
            rule
            ScanTag(c: c, ink: ink)
        }
        .foregroundStyle(ink)
        .padding(.horizontal, 26).padding(.vertical, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(hex: 0xF5F1E8))
        .overlay(alignment: .bottomTrailing) {
            Text(c.called ? "CALLED IT" : "PENDING")
                .font(.mono(28, .medium)).tracking(2)
                .foregroundStyle(c.called ? green : Color(hex: 0x9A7B2A))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(c.called ? green : Color(hex: 0x9A7B2A), lineWidth: 3))
                .rotationEffect(.degrees(-13))
                .opacity(0.85)
                .padding(.trailing, 26).padding(.bottom, 190)
        }
        .mask(Scalloped().fill(style: FillStyle(eoFill: true)))
    }
}

private struct Line: Shape {
    func path(in rect: CGRect) -> Path {
        Path { p in p.move(to: CGPoint(x: 0, y: rect.midY)); p.addLine(to: CGPoint(x: rect.width, y: rect.midY)) }
    }
}

private struct TerminalCard: View {
    let c: CallCard
    @Environment(\.cardCorner) private var corner
    private let amber = Color(hex: 0xFFB000)
    private var green: Color { c.ret >= 0 ? Color(hex: 0x33FF66) : Color(hex: 0xFF4D6D) }

    private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(">").foregroundStyle(Color(hex: 0x33FF66))
            Text(k).frame(width: 52, alignment: .leading).opacity(0.75)
            Text(v)
        }
        .font(.mono(15))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack { Text("THESIS"); Spacer(); Text("CALL <GO>") }
                .font(.mono(15, .medium)).tracking(1.5)
                .foregroundStyle(Color(hex: 0x050505))
                .padding(.horizontal, 18).padding(.vertical, 10)
                .background(amber)
            VStack(alignment: .leading, spacing: 11) {
                row("SUBJ", c.claim.uppercased())
                row("AUTH", c.byline.uppercased())
                row("SIDE", c.isShort ? "SHORT" : "LONG")
                if let since = c.since { row("OPEN", since.uppercased()) }
            }
            .padding(20)
            Spacer(minLength: 4)
            Text(c.called ? "▲ CALLED" : c.ret >= 0 ? "▲ OPEN" : "▼ OPEN")
                .font(.mono(16)).tracking(2).foregroundStyle(green).padding(.horizontal, 20)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(c.pct).font(.mono(80)).tracking(-3).minimumScaleFactor(0.6).lineLimit(1)
                Rectangle().frame(width: 24, height: 54)
            }
            .foregroundStyle(green)
            .shadow(color: green.opacity(0.6), radius: 14)
            .padding(.horizontal, 20)
            Rectangle().fill(amber.opacity(0.25)).frame(height: 1).padding(.top, 22)
            ScanTag(c: c, ink: amber).padding(20)
        }
        .foregroundStyle(amber)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(hex: 0x050505))
        .overlay {
            // Scanlines.
            VStack(spacing: 2) { ForEach(0..<220, id: \.self) { _ in Rectangle().fill(.black.opacity(0.28)).frame(height: 1) } }
                .allowsHitTesting(false)
        }
        .clipShape(RoundedRectangle(cornerRadius: min(corner, 14)))
        .overlay(RoundedRectangle(cornerRadius: min(corner, 14)).strokeBorder(amber.opacity(0.3)).opacity(corner > 0 ? 1 : 0))
    }
}

private struct GoldCard: View {
    let c: CallCard
    @Environment(\.cardCorner) private var corner
    let photo: UIImage?
    private let gold = Color(hex: 0xE8C878)

    var body: some View {
        VStack(spacing: 0) {
            Text("★  \(c.called ? "CALLED IT" : "IN PLAY")  ★").font(.mono(15)).tracking(6).foregroundStyle(gold)
            Text("“\(c.claim)”")
                .font(.serif(claimSize(c.claim, 36, 26)))
                .italic()
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.6)
                .padding(.top, 26)
            Spacer(minLength: 6)
            Text(c.pct)
                .font(.geist(96, .semibold)).tracking(-4)
                .minimumScaleFactor(0.6).lineLimit(1)
                .foregroundStyle(LinearGradient(colors: [Color(hex: 0xFFF6D6), gold, Color(hex: 0xA87B2A)], startPoint: .top, endPoint: .bottom))
                .shadow(color: gold.opacity(0.35), radius: 16, y: 6)
            Text("\(c.sideWord.uppercased())\(c.since.map { " · SINCE \($0.uppercased())" } ?? "")")
                .font(.mono(13)).tracking(1.5).foregroundStyle(gold.opacity(0.75)).padding(.top, 8)
            HStack(spacing: 12) {
                Face(c: c, photo: photo, size: 44)
                VStack(alignment: .leading, spacing: 0) {
                    Text(c.name).font(.geist(18, .semibold))
                    Text(c.byline).font(.geist(14)).opacity(0.6)
                }
            }
            .padding(.top, 18)
            Spacer(minLength: 6)
            Text("CERTIFIED ON THESIS").font(.mono(11)).tracking(3).foregroundStyle(gold.opacity(0.55)).padding(.bottom, 14)
            ScanTag(c: c, ink: gold)
        }
        .foregroundStyle(Color(hex: 0xF3E9D2))
        .padding(.horizontal, 30).padding(.vertical, 36)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            ZStack {
                Color(hex: 0x0B0905)
                RadialGradient(colors: [Color(hex: 0x3A2C10), .clear], center: .top, startRadius: 0, endRadius: 280)
                RadialGradient(colors: [Color(hex: 0x2A1F0A), .clear], center: .bottom, startRadius: 0, endRadius: 220)
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 19).strokeBorder(gold.opacity(0.3)).padding(9))
        .clipShape(RoundedRectangle(cornerRadius: corner))
        .overlay(RoundedRectangle(cornerRadius: corner).strokeBorder(gold.opacity(0.55)))
    }
}

private enum Holo {
    static let gradient = LinearGradient(colors: [Color(hex: 0xFFC8F2), Color(hex: 0xC8F4FF), Color(hex: 0xD6FFC4), Color(hex: 0xFFF1A8), Color(hex: 0xFFC8E0)],
                                         startPoint: .topLeading, endPoint: .bottomTrailing)
}

private struct HoloCard: View {
    let c: CallCard
    @Environment(\.cardCorner) private var corner
    let photo: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Face(c: c, photo: photo, size: 32)
                Text(c.byline).font(.geist(17, .semibold))
            }
            .padding(.leading, 4).padding(.trailing, 12).padding(.vertical, 4)
            .background(.white.opacity(0.65), in: Capsule())
            Text(c.claim)
                .font(.geist(claimSize(c.claim, 42, 30), .semibold)).tracking(-1)
                .minimumScaleFactor(0.6)
                .padding(.top, 30)
            Spacer(minLength: 6)
            Text(c.pct)
                .font(.geist(118, .semibold)).tracking(-7)
                .minimumScaleFactor(0.55).lineLimit(1)
            HStack {
                Text("\(c.sideWord.uppercased())\(c.since.map { " ✦ SINCE \($0.uppercased())" } ?? "")").font(.mono(13))
                Spacer()
                Text("thesis").font(.mono(17, .medium))
            }
            .padding(.top, 10)
            Rectangle().fill(.black.opacity(0.12)).frame(height: 1).padding(.vertical, 16)
            ScanTag(c: c, ink: Color(hex: 0x111111))
        }
        .foregroundStyle(Color(hex: 0x111111))
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            ZStack {
                Holo.gradient
                RadialGradient(colors: [.white.opacity(0.7), .clear], center: .init(x: 0.3, y: 0.2), startRadius: 0, endRadius: 200)
            }
        }
        .overlay(alignment: .topTrailing) {
            Text(c.called ? "CALLED IT!!" : "NOT YET…")
                .font(.geist(20, .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 15).padding(.vertical, 10)
                .background(Color(hex: 0x111111), in: RoundedRectangle(cornerRadius: 12))
                .shadow(color: .black.opacity(0.18), radius: 0, x: 3, y: 4)
                .rotationEffect(.degrees(7))
                .padding(.top, 24).padding(.trailing, 18)
        }
        .clipShape(RoundedRectangle(cornerRadius: corner))
    }
}

private struct PressCard: View {
    let c: CallCard
    @Environment(\.cardCorner) private var corner
    private let ink = Color(hex: 0x161412)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("The Thesis Times").font(.serif(36)).frame(maxWidth: .infinity)
            VStack(spacing: 2) {
                Rectangle().frame(height: 1)
                Rectangle().frame(height: 1)
            }
            .padding(.top, 6)
            HStack {
                Text(Date.now.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().year()).uppercased())
                Spacer()
                Text("LATE EDITION")
                Spacer()
                Text("PLAY MONEY")
            }
            .font(.mono(10)).tracking(1).padding(.vertical, 7)
            Rectangle().frame(height: 1)
            Text(c.called ? "\(c.byline) called it" : "\(c.byline) makes the call")
                .font(.serif(46)).textCase(.uppercase).tracking(-1.5)
                .lineSpacing(-6)
                .minimumScaleFactor(0.6)
                .padding(.top, 20)
            Text("“\(c.claim)”")
                .font(.serif(claimSize(c.claim, 26, 19))).italic().opacity(0.85)
                .minimumScaleFactor(0.7)
                .padding(.top, 12)
            Spacer(minLength: 6)
            Rectangle().frame(height: 1)
            HStack(alignment: .bottom, spacing: 14) {
                Text(c.pct).font(.serif(68)).tracking(-2.5).lineLimit(1).minimumScaleFactor(0.6)
                Text("\(c.sideWord)\(c.whose.map { " \($0)" } ?? " their own take")\(c.since.map { ", posted \($0)" } ?? "")." + " Story continues on thesis.")
                    .font(.geist(14)).lineSpacing(1)
            }
            .padding(.top, 16)
            Rectangle().frame(height: 1).padding(.vertical, 16)
            ScanTag(c: c, ink: ink)
        }
        .foregroundStyle(ink)
        .padding(.horizontal, 24).padding(.vertical, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(hex: 0xEFE8D8))
        .clipShape(RoundedRectangle(cornerRadius: min(corner, 6)))
    }
}

// MARK: - Share from anywhere a take shows

extension AppState {
    /// The card for a take: your position on it if you hold one, else the take as its author's call.
    /// `takeReturn` overrides the take's return (the take page passes the on-chain one).
    func shareCard(for take: Take, takeReturn: Double? = nil) -> CallCard {
        if isOnFork, let p = forkPortfolio?.holdings.first(where: { $0.takeId == take.id }),
           let value = p.valueUsd, let cost = p.heldCostUsd, cost > 0 {
            return CallCard(takeID: take.id, claim: take.claim, ret: (value / cost - 1) * 100, faded: p.side == "fade",
                            author: p.authorHandle ?? take.author.handleID, name: me.name, handle: me.id, avatar: me.avatar,
                            since: take.since, legs: take.legs, inverted: take.inverted)
        }
        if !isOnFork, let p = positions.first(where: { $0.take.id == take.id }) {
            return CallCard(takeID: take.id, claim: take.claim, ret: p.ret, faded: p.side == .fade,
                            author: take.author.handleID, name: me.name, handle: me.id, avatar: me.avatar, since: take.since,
                            legs: take.legs, inverted: take.inverted)
        }
        return CallCard(takeID: take.id, claim: take.claim, ret: takeReturn ?? take.ret, faded: false,
                        author: nil, name: take.author.name, handle: take.author.handleID ?? "", avatar: take.author.avatar,
                        since: take.since, legs: take.legs, inverted: take.inverted)
    }
}

/// A share button that opens the called-it card sheet for a take.
struct ShareCardButton<Label: View>: View {
    @Environment(AppState.self) private var app
    let take: Take
    var takeReturn: Double?
    @ViewBuilder var label: () -> Label
    @State private var card: CallCard?

    var body: some View {
        Button(action: { card = app.shareCard(for: take, takeReturn: takeReturn) }, label: label)
            .sheet(item: $card) { CalledItShareSheet(card: $0) }
            .accessibilityLabel("Share")
    }
}
