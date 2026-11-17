import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// "Thesis" in the iOS share sheet: share an article or an X post from any app, and Thesis opens
/// on a take drafted from it, to edit, build and post.
///
/// The extension only gathers what was shared (the link, the page title, selected text, and in
/// Safari the article's text via Preprocess.js) and hands it to the app as
/// `yourthesis(-dev)://take/new?read=<url>&title=…&text=…`. The app does the reading and drafting
/// with your session (App/TakeLink.swift, Features/Create/CreateFlow.swift ReadingView).
final class ShareViewController: UIViewController {
    private let model = SharedItem()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = ShareCard.background
        let card = ShareCard(model: model,
                             onMake: { [weak self] in self?.make() },
                             onCancel: { [weak self] in self?.cancel() })
        let host = UIHostingController(rootView: card)
        host.view.backgroundColor = ShareCard.background
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        Task { await model.load(items) }
    }

    private func make() {
        guard let link = model.deepLink else { return }
        _ = openApp(link)
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: "xyz.yourthesis.share", code: NSUserCancelledError))
    }

    /// Share extensions can't call UIApplication.shared; the responder chain reaches the app.
    @discardableResult
    private func openApp(_ url: URL) -> Bool {
        var responder: UIResponder? = self
        while let current = responder {
            if let app = current as? UIApplication {
                app.open(url, options: [:], completionHandler: nil)
                return true
            }
            responder = current.next
        }
        return false
    }
}

/// What was shared.
@MainActor
final class SharedItem: ObservableObject {
    @Published var url: URL?
    @Published var title: String?
    @Published var text: String?
    @Published var loaded = false

    private static let scheme = Bundle.main.object(forInfoDictionaryKey: "AppURLScheme") as? String ?? "yourthesis"

    var isX: Bool {
        let host = url?.host()?.lowercased() ?? ""
        return host == "x.com" || host.hasSuffix(".x.com") || host.hasSuffix("twitter.com")
    }

    var site: String {
        if isX { return "Post on X" }
        return url?.host()?.replacingOccurrences(of: "www.", with: "") ?? ""
    }

    var deepLink: URL? {
        guard let url else { return nil }
        var c = URLComponents()
        c.scheme = Self.scheme
        c.host = "take"
        c.path = "/new"
        var items = [URLQueryItem(name: "read", value: url.absoluteString)]
        if let title, !title.isEmpty { items.append(URLQueryItem(name: "title", value: String(title.prefix(300)))) }
        if let text, !text.isEmpty { items.append(URLQueryItem(name: "text", value: String(text.prefix(1500)))) }
        c.queryItems = items
        return c.url
    }

    func load(_ items: [NSExtensionItem]) async {
        defer { loaded = true }
        for item in items {
            if title == nil, let t = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
                // Some apps put the headline here; others put the link itself.
                if URL(string: t)?.scheme?.hasPrefix("http") != true { title = t }
            }
            for provider in item.attachments ?? [] {
                // Safari, with Preprocess.js: the page's URL, title, selection and text.
                if provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier),
                   let dict = try? await provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier) as? [String: Any],
                   let page = dict[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any] {
                    if let u = (page["url"] as? String).flatMap(URL.init(string:)) { url = u }
                    if let t = page["title"] as? String, !t.isEmpty { title = t }
                    let selection = (page["selection"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    text = selection.isEmpty ? page["text"] as? String : selection
                    continue
                }
                if url == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let u = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
                   u.scheme?.hasPrefix("http") == true {
                    url = u
                    continue
                }
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                   let s = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    // Shared text, often "Headline https://…": the link, and the rest as the title.
                    if url == nil, let found = Self.firstLink(in: s) {
                        url = found.url
                        let rest = s.replacingCharacters(in: found.range, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
                        if title == nil, !rest.isEmpty { title = rest }
                    } else if text == nil {
                        text = s
                    }
                }
            }
        }
    }

    private static func firstLink(in s: String) -> (url: URL, range: Range<String.Index>)? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let ns = NSRange(s.startIndex..., in: s)
        for match in detector.matches(in: s, range: ns) {
            if let u = match.url, u.scheme?.hasPrefix("http") == true, let r = Range(match.range, in: s) { return (u, r) }
        }
        return nil
    }
}

/// The card the share sheet shows: what you shared, and "Make a take".
struct ShareCard: View {
    @ObservedObject var model: SharedItem
    let onMake: () -> Void
    let onCancel: () -> Void

    /// Palette.bg: the share sheet is the app's own dark, not a card floating on white.
    static let background = UIColor(red: 0.027, green: 0.031, blue: 0.043, alpha: 1)

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Thesis").font(.system(size: 17, weight: .semibold))
                Text("· make a take").font(.system(size: 17)).foregroundStyle(.secondary)
                Spacer()
                Button(action: onCancel) {
                    Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
                .background(Color.white.opacity(0.08), in: Circle())
                .accessibilityLabel("Cancel")
            }

            if model.url != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.site).font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
                    Text(model.title ?? model.text ?? model.url?.absoluteString ?? "")
                        .font(.system(size: 24, design: .serif))
                        .lineLimit(5)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(18)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(Color.white.opacity(0.08)))

                Text("Thesis reads it and writes the take. You edit it, then Thesis finds what to buy.")
                    .font(.system(size: 14)).foregroundStyle(.secondary)
                Spacer()
                Button(action: onMake) {
                    HStack {
                        Text("Make a take").font(.system(size: 17, weight: .semibold))
                        Image(systemName: "arrow.right").font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(Color.black)
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .background(Color.white, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("share-make-take")
            } else if model.loaded {
                Text("Share a link to an article or an X post to make a take from it.")
                    .font(.system(size: 15)).foregroundStyle(.secondary)
                Spacer()
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 80)
                Spacer()
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(Self.background).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .foregroundStyle(Color.white)
    }
}
