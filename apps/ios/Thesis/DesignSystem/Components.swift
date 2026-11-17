import SwiftUI
import Charts

/// A bundled avatar image, a remote one (https URL), or the first letter of
/// the handle on a tile when there's neither (new real users).
struct Avatar: View {
    let name: String
    var size: CGFloat = 40

    var body: some View {
        content
            .frame(width: size, height: size)
            .clipShape(Circle())
            .accessibilityHidden(true)
    }

    @ViewBuilder private var content: some View {
        if let face = AvatarFace.parse(name) {
            IconAvatar(icon: face.name, color: face.color, size: size)
        } else if UIImage(named: name) != nil {
            Image(name).resizable().scaledToFill()
        } else if name.hasPrefix("file://"), let url = URL(string: name),
                  let image = UIImage(contentsOfFile: url.path) {
            Image(uiImage: image).resizable().scaledToFill()
        } else if name.hasPrefix("https://"), let url = URL(string: name) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Palette.tile
            }
        } else {
            Text(initial)
                .font(.geist(size * 0.42, .semibold))
                .foregroundStyle(Palette.text)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Palette.tile)
        }
    }

    private var initial: String {
        var base = Substring(name)
        if base.hasPrefix("avatar-") { base = base.dropFirst(7) }
        if base.hasPrefix("@") { base = base.dropFirst() }
        return base.first.map { String($0).uppercased() } ?? "?"
    }
}

/// A 3D topic image on a soft tile.
struct TopicTile: View {
    let image: String
    var size: CGFloat = 50
    var corner: CGFloat = 16
    var circle = false

    var body: some View {
        Image(image)
            .resizable()
            .scaledToFit()
            .frame(width: size * 0.66, height: size * 0.66)
            .frame(width: size, height: size)
            .background(Palette.tile, in: circle ? AnyShape(Circle()) : AnyShape(.rect(cornerRadius: corner)))
            .accessibilityHidden(true)
    }
}

struct Hairline: View {
    var body: some View {
        Rectangle().fill(Palette.hairline).frame(height: 1)
    }
}

/// Thin stacked bar of a basket's weights. `excludedWeight` draws a dashed
/// leading segment for legs a fade can't include.
struct AllocationBar: View {
    let legs: [Leg]
    var height: CGFloat = 4
    var excludedWeight: Double = 0

    var body: some View {
        GeometryReader { geo in
            let gap: CGFloat = 2
            let count = legs.count + (excludedWeight > 0 ? 1 : 0)
            let total = legs.reduce(excludedWeight) { $0 + $1.weight }
            let usable = max(0, geo.size.width - gap * CGFloat(max(0, count - 1)))
            HStack(spacing: gap) {
                if excludedWeight > 0 {
                    RoundedRectangle(cornerRadius: height / 2)
                        .strokeBorder(Palette.muted.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                        .frame(width: usable * excludedWeight / total)
                }
                ForEach(legs) { leg in
                    RoundedRectangle(cornerRadius: height / 2)
                        .fill(Palette.series(leg.slot))
                        .frame(width: usable * leg.weight / total)
                }
            }
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityLabel("Basket: " + legs.map { "\($0.name) \(Int($0.weight))%" }.joined(separator: ", "))
    }
}

struct Sparkline: View {
    let values: [Double]
    let color: Color

    var body: some View {
        let lo = values.min() ?? 0
        let hi = values.max() ?? 1
        let last = values.count - 1
        Chart {
            ForEach(values.indices, id: \.self) { i in
                AreaMark(x: .value("t", i), yStart: .value("base", lo), yEnd: .value("v", values[i]))
                    .foregroundStyle(color.opacity(0.10))
                    .interpolationMethod(.catmullRom)
                LineMark(x: .value("t", i), y: .value("v", values[i]))
                    .foregroundStyle(color)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.catmullRom)
            }
            if last >= 0 {
                PointMark(x: .value("t", last), y: .value("v", values[last]))
                    .symbolSize(30)
                    .foregroundStyle(color)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .chartYScale(domain: lo...max(hi, lo + 0.0001))
        .accessibilityHidden(true)
    }
}

/// Back / Fade pill: pastel-tinted Liquid Glass.
struct SidePill: View {
    let side: Side
    var title: String? = nil
    var count: Int? = nil
    var height: CGFloat = 44
    var expand = false
    var horizontalPadding: CGFloat = 18
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(title ?? side.title).font(.geist(15, .semibold))
                if let count {
                    Text("\(count)").font(.mono(12, .medium))
                }
            }
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(side.ink)
            .padding(.horizontal, horizontalPadding)
            .frame(maxWidth: expand ? .infinity : nil, minHeight: height)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.tint(side.fill.opacity(0.85)).interactive(), in: .capsule)
    }
}

/// Small Trade / Fade pill for feed rows: soft tint, colored text, a thin
/// outline and a direction arrow. Quieter than `SidePill`, which is for the
/// main call to action on the take page and trade sheet.
struct CompactSidePill: View {
    let side: Side
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: side.arrow)
                    .font(.system(size: 11, weight: .bold))
                    .accessibilityHidden(true)
                Text(side.title).font(.geist(14, .semibold))
                Text("\(count)").font(.mono(12, .medium)).opacity(0.75)
            }
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(side.text)
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(side.soft, in: .capsule)
            .overlay(Capsule().strokeBorder(side.text.opacity(0.28), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(side.title), \(count)")
        .accessibilityAddTraits(.isButton)
    }
}

/// Full-width primary action in clear Liquid Glass.
struct PrimaryGlassButton: View {
    let title: String
    var systemImage: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                if let systemImage { Image(systemName: systemImage) }
            }
            .font(.geist(16, .semibold))
            .frame(maxWidth: .infinity, minHeight: 36)
        }
        .buttonStyle(.glass)
        .controlSize(.large)
    }
}

/// Underlined text tabs (X-style), used for feed tabs, ranking metric and
/// profile sections.
struct UnderlineTabs<Value: Hashable>: View {
    let items: [(Value, String)]
    @Binding var selection: Value
    var equalWidth = false
    var spacing: CGFloat = 20

    var body: some View {
        HStack(spacing: equalWidth ? 0 : spacing) {
            ForEach(items, id: \.0) { value, label in
                Button {
                    withAnimation(.snappy) { selection = value }
                } label: {
                    Text(label)
                        .font(.geist(15, selection == value ? .semibold : .medium))
                        .foregroundStyle(selection == value ? Palette.text : Palette.muted)
                        .frame(maxWidth: equalWidth ? .infinity : nil, minHeight: 46)
                        .overlay(alignment: .bottom) {
                            Capsule()
                                .fill(selection == value ? Palette.text : .clear)
                                .frame(width: equalWidth ? 56 : nil, height: 3)
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == value ? .isSelected : [])
            }
        }
    }
}

/// Small mono range switch ("1D 1W All") like Fomo's chart header.
struct RangePicker: View {
    let options: [String]
    @Binding var selection: String

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.self) { option in
                let on = option == selection
                Button {
                    withAnimation(.snappy) { selection = option }
                } label: {
                    Text(option)
                        .font(.mono(12))
                        .foregroundStyle(on ? Palette.text : Palette.muted)
                        .frame(minWidth: 40, minHeight: 32)
                        .background(on ? Palette.tile : .clear, in: .rect(cornerRadius: 10))
                        .overlay {
                            RoundedRectangle(cornerRadius: 10)
                                .strokeBorder(on ? Palette.hairline : .clear)
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }
}

/// Topic / filter chip in Liquid Glass; the selected one is brighter.
struct GlassChip: View {
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.geist(14, .semibold))
                .foregroundStyle(Palette.text)
                .padding(.horizontal, 16)
                .frame(minHeight: 40)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(selected ? .regular.tint(Palette.text.opacity(0.22)).interactive() : .regular.interactive(), in: .capsule)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Your avatar in the top-left toolbar; opens the profile sidebar.
struct ProfileMenuButton: View {
    @Environment(AppState.self) private var app

    var body: some View {
        Button { app.drawerOpen = true } label: {
            Avatar(name: app.me.avatar, size: 32)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open profile menu")
    }
}

/// Bookmark toggle, X-style. Saved takes show up under Saved in the sidebar.
struct SaveButton: View {
    @Environment(AppState.self) private var app
    let take: Take

    var body: some View {
        let saved = app.isSaved(take)
        Button {
            withAnimation(.snappy) { app.toggleSave(take) }
        } label: {
            Image(systemName: saved ? "bookmark.fill" : "bookmark")
                .foregroundStyle(saved ? Palette.text : Palette.muted)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 36, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: saved)
        .accessibilityLabel(saved ? "Remove from saved" : "Save")
    }
}

struct LockedNote: View {
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "lock.fill").font(.system(size: 10))
            Text(text)
        }
        .font(.mono(11))
        .foregroundStyle(Palette.muted)
        .frame(maxWidth: .infinity)
    }
}
