// Renders the badge catalog's images (512×512 PNG) into infra/badges/images/: a dark medallion with a
// stepped pixel ring, a 16×16 pixel emblem, and the figure in the wordmark's pixel font.
//
//   swift infra/badges/render.swift
//
// CoreGraphics and CoreText only, with the app's Geist and Geist Pixel fonts and palette
// (apps/ios/Thesis/DesignSystem/Palette.swift), so nothing needs installing. Rerun after changing
// a design; `pnpm badges:upload` puts the images and their metadata in Supabase Storage.
import AppKit
import CoreText

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let fonts = root.appendingPathComponent("../../apps/ios/Thesis/Resources/Fonts").standardized
for name in ["Geist-Medium", "GeistPixel-Square"] {
    CTFontManagerRegisterFontsForURL(fonts.appendingPathComponent("\(name).ttf") as CFURL, .process, nil)
}

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

struct Badge {
    let slug: String
    /// Small caps over the emblem.
    let kicker: String
    /// A key of `emblems`.
    let emblem: String
    /// Under the emblem, in the pixel font.
    let figure: String
    /// Under the figure.
    let caption: String
    /// Light and dark tone: the ring and figure run between them; the emblem uses the dark
    /// tone, and the light one for its highlights.
    let colors: [UInt32]
}

let badges = [
    Badge(slug: "first-take", kicker: "THESIS", emblem: "quote", figure: "1ST", caption: "First take", colors: [0xF2F3F5, 0x9AA0AA]),
    Badge(slug: "first-50", kicker: "CALLED IT", emblem: "arrow", figure: "+50%", caption: "First take", colors: [0xC9F2D5, 0x5FBF7E]),
    Badge(slug: "first-100", kicker: "CALLED IT", emblem: "trophy", figure: "+100%", caption: "First take", colors: [0xF6E3A1, 0xD9A43A]),
    Badge(slug: "ten-50", kicker: "CALLED IT", emblem: "crown", figure: "10×", caption: "Ten takes at +50%", colors: [0xB8F0F2, 0x4FB3D9]),
    Badge(slug: "over-1000", kicker: "CALLED IT", emblem: "rocket", figure: "+1,000%", caption: "One take", colors: [0xF3B6CC, 0xA98BEF]),
]

/// 16×16 pixel emblems, top row first: "#" dark tone, "+" light tone, "." empty.
let emblems: [String: [String]] = [
    "quote": [
        "................",
        "................",
        "................",
        "..############..",
        ".##############.",
        ".####+####+####.",
        ".###++###++####.",
        ".###++###++####.",
        ".##############.",
        ".##############.",
        "..############..",
        "...##...........",
        "...#............",
        "................",
        "................",
        "................",
    ],
    "arrow": [
        "................",
        ".......##.......",
        "......####......",
        ".....######.....",
        "....##++####....",
        "...##++######...",
        "..##++########..",
        ".##++##########.",
        ".....+#####.....",
        ".....+#####.....",
        ".....+#####.....",
        ".....+#####.....",
        ".....+#####.....",
        ".....+#####.....",
        ".....######.....",
        "................",
    ],
    "trophy": [
        "................",
        "..############..",
        "##.#+++######.##",
        "#..#+++######..#",
        "#..#+++######..#",
        ".#.#+++######.#.",
        "...###+######...",
        "....##+#####....",
        ".....######.....",
        "......####......",
        ".......##.......",
        ".......##.......",
        ".....######.....",
        "....########....",
        "....#++++++#....",
        "....########....",
    ],
    "crown": [
        "................",
        "................",
        "................",
        ".#.....##.....#.",
        ".##....##....##.",
        ".###..####..###.",
        ".####.####.####.",
        ".##############.",
        ".##############.",
        ".##+##+##+##+##.",
        ".##############.",
        ".++++++++++++++.",
        ".##############.",
        "................",
        "................",
        "................",
    ],
    "rocket": [
        ".......##.......",
        "......####......",
        ".....##++##.....",
        ".....#++++#.....",
        ".....######.....",
        ".....##..##.....",
        ".....##..##.....",
        ".....######.....",
        ".....######.....",
        "....########....",
        "...##.####.##...",
        "..###.####.###..",
        "..##..++++..##..",
        "......++++......",
        ".......++.......",
        "................",
    ],
]

let size: CGFloat = 512

func text(_ s: String, font: String, size: CGFloat, color: CGColor, kern: CGFloat = 0) -> CTLine {
    let f = CTFontCreateWithName(font as CFString, size, nil)
    let attrs: [NSAttributedString.Key: Any] = [.font: f, .foregroundColor: color, .kern: kern]
    return CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
}

/// Where to put a line so its glyphs' box is centered at (size / 2, y), and that box.
func place(_ line: CTLine, in ctx: CGContext, centerY y: CGFloat) -> (CGPoint, CGRect) {
    // Image bounds are relative to the current text position: measure from the origin.
    ctx.textPosition = .zero
    let b = CTLineGetImageBounds(line, ctx)
    return (CGPoint(x: (size - b.width) / 2 - b.minX, y: y - b.height / 2 - b.minY), b)
}

func draw(_ line: CTLine, in ctx: CGContext, centerY y: CGFloat) {
    let (origin, _) = place(line, in: ctx, centerY: y)
    ctx.textPosition = origin
    CTLineDraw(line, ctx)
}

/// A line whose glyphs are filled with the badge's gradient, top to bottom: the text is drawn
/// into a mask, and the gradient through it.
func drawGradient(_ line: CTLine, in ctx: CGContext, centerY y: CGFloat, colors: [CGColor]) {
    let (origin, b) = place(line, in: ctx, centerY: y)
    let mask = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0,
                         space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    mask.setFillColor(gray: 0, alpha: 1)
    mask.fill(CGRect(x: 0, y: 0, width: size, height: size))
    mask.textPosition = origin
    CTLineDraw(line, mask)
    ctx.saveGState()
    ctx.clip(to: CGRect(x: 0, y: 0, width: size, height: size), mask: mask.makeImage()!)
    let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: nil)!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: origin.y + b.maxY), end: CGPoint(x: 0, y: origin.y + b.minY), options: [])
    ctx.restoreGState()
}

func render(_ badge: Badge) throws {
    let space = CGColorSpaceCreateDeviceRGB()
    let ctx = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let colors = badge.colors.map { rgb($0) }
    let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: nil)!
    let center = CGPoint(x: size / 2, y: size / 2)

    // Medallion: the app's dark background with a soft glow of the badge's color.
    let disc = CGRect(x: 24, y: 24, width: size - 48, height: size - 48)
    ctx.saveGState()
    ctx.addEllipse(in: disc)
    ctx.clip()
    ctx.setFillColor(rgb(0x07080B))
    ctx.fill(disc)
    let glow = CGGradient(colorsSpace: space, colors: [rgb(badge.colors[0], 0.2), rgb(badge.colors[0], 0)] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: center.x, y: center.y + 40), startRadius: 0, endCenter: CGPoint(x: center.x, y: center.y + 40), endRadius: 256, options: [])
    ctx.restoreGState()

    // Stepped pixel ring: the 16 px cells whose centers sit 222–246 px out, filled with the gradient.
    let cell: CGFloat = 16
    var ring: [CGRect] = []
    for y in stride(from: 0, to: size, by: cell) {
        for x in stride(from: 0, to: size, by: cell) {
            let d = hypot(x + cell / 2 - center.x, y + cell / 2 - center.y)
            if d >= 222 && d < 246 { ring.append(CGRect(x: x, y: y, width: cell, height: cell)) }
        }
    }
    ctx.saveGState()
    ctx.addRects(ring)
    ctx.clip()
    ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size), end: CGPoint(x: size, y: 0), options: [])
    ctx.restoreGState()

    // Emblem: 12 px pixels, 192 px square, its top 130 px from the top; a soft shadow under it.
    let grid = emblems[badge.emblem]!
    let px: CGFloat = 12, left: CGFloat = 160, top: CGFloat = 130
    func pixels(_ dx: CGFloat, _ dy: CGFloat, _ pick: (Character) -> CGColor?) {
        for (row, line) in grid.enumerated() {
            for (col, ch) in line.enumerated() {
                guard let color = pick(ch) else { continue }
                ctx.setFillColor(color)
                ctx.fill(CGRect(x: left + CGFloat(col) * px + dx, y: size - top - CGFloat(row + 1) * px - dy, width: px, height: px))
            }
        }
    }
    pixels(6, 6) { $0 == "." ? nil : rgb(0x000000, 0.35) }
    pixels(0, 0) { $0 == "#" ? colors[1] : $0 == "+" ? colors[0] : nil }

    // Kicker, figure, caption (centers measured from the bottom, as CoreGraphics does).
    draw(text(badge.kicker, font: "GeistPixel-Square", size: 24, color: rgb(0x9AA0AA), kern: 4), in: ctx, centerY: size - 104)
    let figureSize: CGFloat = badge.figure.count >= 6 ? 50 : badge.figure.count >= 5 ? 58 : 64
    drawGradient(text(badge.figure, font: "GeistPixel-Square", size: figureSize, color: rgb(0xFFFFFF)), in: ctx, centerY: size - 368, colors: colors)
    draw(text(badge.caption, font: "Geist-Medium", size: 24, color: rgb(0xF2F3F5)), in: ctx, centerY: size - 422)

    let out = root.appendingPathComponent("images/\(badge.slug).png")
    try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try rep.representation(using: .png, properties: [:])!.write(to: out)
    print("wrote \(out.path)")
}

for b in badges { try render(b) }
