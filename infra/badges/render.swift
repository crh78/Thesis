// Renders the badge catalog's images (512×512 PNG) into infra/badges/images/.
//
//   swift infra/badges/render.swift
//
// CoreGraphics and CoreText only, with the app's Geist fonts and palette
// (apps/ios/Thesis/DesignSystem/Palette.swift), so nothing needs installing. Rerun after changing
// a design; `pnpm badges:upload` puts the images and their metadata in Supabase Storage.
import AppKit
import CoreText

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let fonts = root.appendingPathComponent("../../apps/ios/Thesis/Resources/Fonts").standardized
for name in ["Geist-SemiBold", "Geist-Medium", "GeistMono-SemiBold", "GeistSerif-Regular", "GeistPixel-Square"] {
    CTFontManagerRegisterFontsForURL(fonts.appendingPathComponent("\(name).ttf") as CFURL, .process, nil)
}

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

struct Badge {
    let slug: String
    /// Small caps over the figure.
    let kicker: String
    let figure: String
    let figureFont: String
    /// Under the figure.
    let caption: String
    /// Ring and figure colors, top to bottom.
    let colors: [UInt32]
}

let badges = [
    Badge(slug: "first-take", kicker: "THESIS", figure: "\u{201C}", figureFont: "GeistSerif-Regular", caption: "First take", colors: [0xF2F3F5, 0x9AA0AA]),
    Badge(slug: "first-50", kicker: "CALLED IT", figure: "+50%", figureFont: "GeistMono-SemiBold", caption: "First take", colors: [0xC9F2D5, 0x7FD39A]),
    Badge(slug: "first-100", kicker: "CALLED IT", figure: "+100%", figureFont: "GeistMono-SemiBold", caption: "First take", colors: [0xF6E3A1, 0xE0B44C]),
    Badge(slug: "ten-50", kicker: "CALLED IT", figure: "10×", figureFont: "GeistMono-SemiBold", caption: "Ten takes at +50%", colors: [0xA9E3BA, 0x6FC7E8]),
    Badge(slug: "over-1000", kicker: "CALLED IT", figure: "+1,000%", figureFont: "GeistMono-SemiBold", caption: "One take", colors: [0xA9E3BA, 0xF3B6CC, 0xC9B6F3]),
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
    let disc = CGRect(x: 16, y: 16, width: size - 32, height: size - 32)
    ctx.saveGState()
    ctx.addEllipse(in: disc)
    ctx.clip()
    ctx.setFillColor(rgb(0x07080B))
    ctx.fill(disc)
    let glow = CGGradient(colorsSpace: space, colors: [rgb(badge.colors[0], 0.22), rgb(badge.colors[0], 0)] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: center.x, y: center.y + 60), startRadius: 0, endCenter: center, endRadius: 250, options: [])
    ctx.restoreGState()

    // Gradient ring, and a hairline inside it.
    ctx.saveGState()
    ctx.setLineWidth(14)
    ctx.addEllipse(in: disc.insetBy(dx: 7, dy: 7))
    ctx.replacePathWithStrokedPath()
    ctx.clip()
    ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size), end: CGPoint(x: size, y: 0), options: [])
    ctx.restoreGState()
    ctx.setStrokeColor(rgb(0xFFFFFF, 0.09))
    ctx.setLineWidth(2)
    ctx.strokeEllipse(in: disc.insetBy(dx: 30, dy: 30))

    // Kicker, figure, caption.
    draw(text(badge.kicker, font: "GeistPixel-Square", size: 30, color: rgb(0x9AA0AA), kern: 4), in: ctx, centerY: size * 0.73)
    let figureSize: CGFloat = badge.figure.count >= 6 ? 92 : badge.figure.count >= 5 ? 112 : badge.figure == "\u{201C}" ? 340 : 132
    let figureY = badge.figure == "\u{201C}" ? size * 0.51 : size * 0.5
    drawGradient(text(badge.figure, font: badge.figureFont, size: figureSize, color: rgb(0xFFFFFF)), in: ctx, centerY: figureY, colors: colors)
    draw(text(badge.caption, font: "Geist-Medium", size: 32, color: rgb(0xF2F3F5)), in: ctx, centerY: size * 0.28)

    let out = root.appendingPathComponent("images/\(badge.slug).png")
    try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try rep.representation(using: .png, properties: [:])!.write(to: out)
    print("wrote \(out.path)")
}

for b in badges { try render(b) }
