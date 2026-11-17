import SwiftUI
import Charts

/// Smooth area + line chart. Drag across it to scrub; the caller reads
/// `selection` to update its headline number.
struct PerformanceChart: View {
    let values: [Double]
    var color: Color = Palette.up
    var showEntryLine = false
    var height: CGFloat = 160
    @Binding var selection: Int?

    var body: some View {
        let lo = min(values.min() ?? 0, showEntryLine ? 0 : .infinity)
        let hi = values.max() ?? 1
        let last = max(0, values.count - 1)
        let idx = min(max(selection ?? last, 0), last)

        Chart {
            ForEach(values.indices, id: \.self) { i in
                AreaMark(x: .value("t", i), yStart: .value("base", lo), yEnd: .value("v", values[i]))
                    .foregroundStyle(
                        LinearGradient(colors: [color.opacity(0.22), color.opacity(0)], startPoint: .top, endPoint: .bottom)
                    )
                    .interpolationMethod(.catmullRom)
                LineMark(x: .value("t", i), y: .value("v", values[i]))
                    .foregroundStyle(color)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.catmullRom)
            }
            if showEntryLine {
                RuleMark(y: .value("Entry", 0))
                    .foregroundStyle(Palette.muted.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 5]))
                    .annotation(position: .top, alignment: .leading) {
                        Text("ENTRY").font(.mono(10)).foregroundStyle(Palette.muted)
                    }
            }
            if selection != nil {
                RuleMark(x: .value("t", idx))
                    .foregroundStyle(Palette.muted.opacity(0.5))
                    .lineStyle(StrokeStyle(lineWidth: 1))
            }
            if !values.isEmpty {
                PointMark(x: .value("t", idx), y: .value("v", values[idx]))
                    .symbolSize(80)
                    .foregroundStyle(color)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .chartXScale(domain: 0...max(1, last))
        .chartYScale(domain: lo...max(hi, lo + 0.0001))
        .chartXSelection(value: $selection)
        .chartPlotStyle { $0.padding(.horizontal, 10).padding(.vertical, 6) }
        .frame(height: height)
    }
}

/// Basket split as a donut with rounded, spaced slices. The selected slice
/// grows; the rest dim.
struct BasketDonut: View {
    let legs: [Leg]
    var selected: Leg.ID? = nil
    var innerRatio: CGFloat = 0.74

    var body: some View {
        Chart(legs) { leg in
            SectorMark(
                angle: .value("Weight", leg.weight),
                innerRadius: .ratio(innerRatio),
                outerRadius: .ratio(selected == leg.id ? 1 : 0.93),
                angularInset: 2.5
            )
            .cornerRadius(6)
            .foregroundStyle(Palette.series(leg.slot))
            .opacity(selected == nil || selected == leg.id ? 1 : 0.3)
        }
        .chartLegend(.hidden)
        .animation(.smooth, value: selected)
        .accessibilityElement()
        .accessibilityLabel("Basket split: " + legs.map { "\($0.name) \(Int($0.weight))%" }.joined(separator: ", "))
    }
}
