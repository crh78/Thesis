import SwiftUI

// Animated art for the welcome screen, drawn in code from the same components
// and mock takes the app uses. Holds a single frame when Reduce Motion is on.

// MARK: - Clock

/// Seconds since the view appeared, every frame (or one fixed frame with Reduce Motion).
private struct HeroClock<Content: View>: View {
    var frozenAt: Double
    @ViewBuilder var content: (Double) -> Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()

    var body: some View {
        if reduceMotion {
            content(frozenAt)
        } else {
            TimelineView(.animation) { context in
                content(context.date.timeIntervalSince(start))
            }
        }
    }
}

private func progress(_ t: Double, from start: Double, duration: Double) -> Double {
    min(1, max(0, (t - start) / duration))
}

private func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }

// MARK: - Take story

/// The product in one loop: you type a take → it becomes a basket → the chart
/// draws and the return climbs → friends trade it or fade it.
/// Cycles through a few takes.
struct TakeStoryHero: View {
    private static let takes = [MockData.aiPower, MockData.nuclear, MockData.fedCut]
    private static let cycle = 11.5

    var body: some View {
        HeroClock(frozenAt: 9.2) { t in
            let index = Int(t / Self.cycle) % Self.takes.count
            let local = t.truncatingRemainder(dividingBy: Self.cycle)
            StoryFrame(take: Self.takes[index], t: local, round: Int(t / Self.cycle), cycle: Self.cycle)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("You type a take, it becomes a basket of picks, and friends trade it or fade it")
    }
}

private struct TradeEvent: Identifiable {
    let id: Int
    let person: Person
    let side: Side
    let amount: Int
}

private struct StoryFrame: View {
    let take: Take
    let t: Double
    let round: Int
    let cycle: Double

    private static let events: [TradeEvent] = {
        let people = [MockData.priya, MockData.lena, MockData.dev, MockData.mo, MockData.kai,
                      MockData.jake, MockData.me, MockData.priya, MockData.dev]
        let sides: [Side] = [.back, .back, .fade, .back, .back, .back, .fade, .back, .back]
        let amounts = [50, 20, 25, 100, 40, 30, 20, 75, 50]
        return people.indices.map { TradeEvent(id: $0, person: people[$0], side: sides[$0], amount: amounts[$0]) }
    }()

    // Timeline (seconds into the cycle).
    private var typeEnd: Double { 0.3 + Double(take.claim.count) * 0.04 }
    private func legStart(_ i: Int) -> Double { typeEnd + 0.2 + Double(i) * 0.22 }
    private var chartStart: Double { legStart(take.legs.count - 1) + 0.9 }
    private var tradeStart: Double { chartStart + 1.5 }
    private let tradeInterval = 0.55

    var body: some View {
        let typed = Int(Double(take.claim.count) * progress(t, from: 0.3, duration: typeEnd - 0.3))
        // Picks fade out first, then the chart draws in their place (no overlap).
        let legsOut = progress(t, from: chartStart - 0.35, duration: 0.3)
        let chartP = easeOut(progress(t, from: chartStart, duration: 1.2))
        let tradeP = progress(t, from: tradeStart - 0.3, duration: 0.3)
        let tradeCount = t < tradeStart ? 0 : min(Self.events.count, Int((t - tradeStart) / tradeInterval) + 1)
        let out = progress(t, from: cycle - 0.55, duration: 0.5)

        VStack(alignment: .leading, spacing: 0) {
            Text("YOUR TAKE").font(.mono(11)).foregroundStyle(Palette.muted)

            // The full claim reserves its space so nothing jumps while it types.
            ZStack(alignment: .topLeading) {
                Text(take.claim).opacity(0)
                HStack(alignment: .firstTextBaseline, spacing: 1) {
                    Text(String(take.claim.prefix(typed)))
                    if t < typeEnd + 0.5 {
                        Rectangle()
                            .fill(Palette.text)
                            .frame(width: 2, height: 24)
                            .opacity(sin(t * 9) > 0 ? 1 : 0)
                    }
                }
            }
            .font(.serif(28))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 10)

            // Basket, then the chart.
            HStack(alignment: .center, spacing: 20) {
                ZStack {
                    DonutArcs(legs: take.legs) { i in easeOut(progress(t, from: legStart(i), duration: 0.45)) }
                    Text("\(take.legs.count) PICKS")
                        .font(.mono(10))
                        .foregroundStyle(Palette.muted)
                        .opacity(progress(t, from: legStart(0), duration: 0.4))
                }
                .frame(width: 96, height: 96)

                ZStack(alignment: .leading) {
                    legList.opacity(1 - legsOut)
                    chart(chartP).opacity(min(1, chartP * 2.5))
                }
                .frame(height: 96)
            }
            .padding(.top, 18)

            trading(Array(Self.events.prefix(tradeCount)))
                .opacity(tradeP)
                .padding(.top, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .opacity(1 - out)
        .offset(y: -8 * out)
    }

    private var legList: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(take.legs.enumerated()), id: \.offset) { i, leg in
                let p = easeOut(progress(t, from: legStart(i), duration: 0.4))
                HStack(spacing: 8) {
                    Circle().fill(Palette.series(leg.slot)).frame(width: 8, height: 8)
                    Text(leg.name).font(.geist(14, .medium)).lineLimit(1)
                    Spacer(minLength: 4)
                    Text("\(Int(leg.weight))%").font(.mono(12)).foregroundStyle(Palette.muted)
                }
                .opacity(p)
                .offset(x: (1 - p) * 14)
            }
        }
    }

    private func chart(_ p: Double) -> some View {
        let color = take.ret >= 0 ? Palette.up : Palette.down
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Fmt.pct(take.ret * p))
                    .font(.geist(26, .bold))
                    .foregroundStyle(color)
                    .monospacedDigit()
                Text(take.horizon.uppercased()).font(.mono(11)).foregroundStyle(Palette.muted)
            }
            ZStack {
                TakeLine(values: take.history, closed: true)
                    .fill(LinearGradient(colors: [color.opacity(0.25), color.opacity(0)], startPoint: .top, endPoint: .bottom))
                    .opacity(p)
                TakeLine(values: take.history)
                    .trim(from: 0, to: p)
                    .stroke(color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
            }
            .frame(maxHeight: .infinity)
        }
    }

    private func trading(_ events: [TradeEvent]) -> some View {
        let backs = events.filter { $0.side == .back }
        let fades = events.filter { $0.side == .fade }
        let share = events.isEmpty ? 0.5 : Double(backs.count) / Double(events.count)
        let latest = events.last
        let total = events.reduce(0) { $0 + $1.amount }

        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Text("$\(total) on your take")
                    .foregroundStyle(Palette.text)
                    .contentTransition(.numericText(value: Double(total)))
                Text("· \(events.count) \(events.count == 1 ? "person" : "people")")
                    .foregroundStyle(Palette.muted)
                    .contentTransition(.numericText(value: Double(events.count)))
            }
            .font(.geist(14, .medium))
            .monospacedDigit()
            .animation(.snappy, value: events.count)

            GeometryReader { geo in
                HStack(spacing: 3) {
                    Capsule().fill(Palette.backFill).frame(width: max(8, (geo.size.width - 3) * share))
                    Capsule().fill(Palette.fadeFill)
                }
            }
            .frame(height: 6)
            .animation(.smooth(duration: 0.45), value: share)

            HStack(alignment: .center) {
                side(.back, events: backs)
                Spacer()
                side(.fade, events: fades)
            }

            ZStack(alignment: .leading) {
                if let latest {
                    Text("\(latest.person.name) \(latest.side == .back ? "traded" : "faded") $\(latest.amount)")
                        .font(.geist(14, .medium))
                        .foregroundStyle(latest.side.text)
                        .id("\(round)-\(latest.id)")
                        .transition(.push(from: .bottom).combined(with: .opacity))
                }
            }
            .frame(height: 20, alignment: .leading)
            .clipped()
            .animation(.snappy, value: latest?.id)
        }
    }

    private func side(_ side: Side, events: [TradeEvent]) -> some View {
        let count = Text("\(events.count)")
            .font(.geist(22, .bold))
            .contentTransition(.numericText(value: Double(events.count)))
        let label = Text(side == .back ? "TRADED" : "FADED").font(.mono(11)).foregroundStyle(side.text)
        let avatars = HStack(spacing: -10) {
            ForEach(events.suffix(4)) { event in
                Avatar(name: event.person.avatar, size: 30)
                    .overlay(Circle().strokeBorder(side.fill, lineWidth: 2))
                    .id("\(round)-\(event.id)")
                    .transition(.asymmetric(
                        insertion: .offset(y: 22).combined(with: .scale(scale: 0.4)).combined(with: .opacity),
                        removal: .opacity))
            }
        }
        .frame(height: 30)
        .animation(.spring(duration: 0.5, bounce: 0.4), value: events.count)

        return HStack(spacing: 10) {
            if side == .back {
                label; count; avatars
            } else {
                avatars; count; label
            }
        }
        .animation(.snappy, value: events.count)
    }
}

/// A take's return history as a line (or a closed area under it).
private struct TakeLine: Shape {
    let values: [Double]
    var closed = false

    func path(in rect: CGRect) -> Path {
        guard values.count > 1, let lo = values.min(), let hi = values.max() else { return Path() }
        let span = max(hi - lo, 0.0001)
        let points = values.enumerated().map { i, v in
            CGPoint(x: rect.minX + rect.width * CGFloat(i) / CGFloat(values.count - 1),
                    y: rect.maxY - rect.height * CGFloat((v - lo) / span))
        }
        var path = Path()
        path.move(to: points[0])
        for i in 1..<points.count {
            let prev = points[i - 1], cur = points[i]
            let mid = CGPoint(x: (prev.x + cur.x) / 2, y: (prev.y + cur.y) / 2)
            path.addQuadCurve(to: mid, control: prev)
        }
        path.addLine(to: points[points.count - 1])
        if closed {
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.closeSubpath()
        }
        return path
    }
}

/// Donut drawn as separate rounded arcs, each revealed by `fill(i)` (0…1).
private struct DonutArcs: View {
    let legs: [Leg]
    let fill: (Int) -> Double
    var lineWidth: CGFloat = 12

    var body: some View {
        Canvas { context, size in
            let total = legs.reduce(0) { $0 + $1.weight }
            let radius = min(size.width, size.height) / 2 - lineWidth / 2
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let gap = 0.09 // radians between slices
            var angle = -Double.pi / 2
            for (i, leg) in legs.enumerated() {
                let sweep = leg.weight / total * 2 * .pi
                let p = fill(i)
                if p > 0 {
                    var path = Path()
                    path.addArc(center: center, radius: radius,
                                startAngle: .radians(angle + gap / 2),
                                endAngle: .radians(angle + gap / 2 + (sweep - gap) * p),
                                clockwise: false)
                    context.stroke(path, with: .color(Palette.series(leg.slot)),
                                   style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                }
                angle += sweep
            }
        }
    }
}

// MARK: - Aurora

/// Slow-moving mesh of the app's accent colors across the whole welcome screen,
/// brightest at the top and quieter behind the text and buttons.
struct AuroraBackground: View {
    var body: some View {
        HeroClock(frozenAt: 2) { t in
            let a = Float(t * 0.3)
            MeshGradient(
                width: 3, height: 3,
                points: [
                    [0, 0], [0.5 + 0.14 * sin(a), 0], [1, 0],
                    [0, 0.45 + 0.1 * sin(a * 1.3)], [0.5 + 0.2 * cos(a * 0.8), 0.45 + 0.12 * sin(a * 1.1)], [1, 0.5 + 0.1 * cos(a)],
                    [0, 1], [0.5 + 0.18 * sin(a * 0.7), 1], [1, 1],
                ],
                colors: [
                    Color(hex: 0x8296FF, alpha: 0.55), Color(hex: 0xF3B6CC, alpha: 0.42), Color(hex: 0xA9E3BA, alpha: 0.40),
                    Color(hex: 0xA9E3BA, alpha: 0.20), Color(hex: 0x8296FF, alpha: 0.34), Color(hex: 0xF3B6CC, alpha: 0.24),
                    Color(hex: 0xF3B6CC, alpha: 0.14), Color(hex: 0x8296FF, alpha: 0.18), Color(hex: 0xA9E3BA, alpha: 0.12),
                ],
                smoothsColors: true
            )
        }
        .background(Palette.bg)
        // A light scrim keeps the text and buttons readable without hiding the color.
        .overlay(
            LinearGradient(colors: [.clear, Palette.bg.opacity(0.45)],
                           startPoint: UnitPoint(x: 0.5, y: 0.4), endPoint: .bottom)
        )
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}
