#if DEBUG
import SwiftUI

/// Debug-only: launch straight into a screen, e.g.
/// `xcrun simctl launch booted com.thesis.app -screen take`.
/// Handy for screenshots. Not compiled into release builds.
enum DebugRoute: String {
    case feed, search, scores, me
    case take, back, fade, comments
    case create, building, basket
    case drawer, saved, followers
    case addcash, withdraw, cash, editprofile, startcash, sell
    case loading

    static var current: DebugRoute? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-screen"), i + 1 < args.count else { return nil }
        return DebugRoute(rawValue: args[i + 1])
    }

    var tab: AppTab? {
        switch self {
        case .feed, .drawer: .home
        case .search: .search
        case .scores: .scores
        case .me: .me
        default: nil
        }
    }
}

/// Screens that live outside the tab bar, opened directly.
struct DebugScreen: View {
    let route: DebugRoute
    @State private var draft = TakeDraft()

    var body: some View {
        switch route {
        case .loading:
            ThesisLoader(lines: ["Signing you in", "Making your wallet", "Setting up your account"],
                         state: .connecting, wordmark: true)
        case .take:
            NavigationStack { TakeDetailView(take: MockData.aiPower) }
        case .back, .fade:
            NavigationStack { TakeDetailView(take: MockData.aiPower) }
                .sheet(isPresented: .constant(true)) {
                    TradeSheet(intent: TradeIntent(take: MockData.aiPower, side: route == .back ? .back : .fade))
                }
        case .comments:
            NavigationStack { TakeDetailView(take: MockData.aiPower) }
                .sheet(isPresented: .constant(true)) { CommentsView(take: MockData.aiPower) }
        case .create:
            NavigationStack { CreateTakeView(draft: $draft, onClose: {}, onNext: {}) }
        case .building:
            NavigationStack { BuildingView(draft: $draft, onNext: {}) }
        case .basket:
            NavigationStack { BasketView(draft: $draft, onPost: {}) }
        case .saved:
            NavigationStack { SavedView().navigationDestination(for: Take.self) { TakeDetailView(take: $0) } }
        case .followers:
            NavigationStack { ConnectionsView(initialTab: .followers) }
        case .addcash:
            AddCashView()
        case .withdraw:
            WithdrawView()
        case .cash:
            CashSheet()
        case .editprofile:
            EditProfileView()
        case .startcash:
            StartWithCashView()
        case .sell:
            NavigationStack { TakeDetailView(take: MockData.aiPower) }
                .sheet(isPresented: .constant(true)) { SellSheet(position: MockData.positions[0]) }
        default:
            EmptyView()
        }
    }
}
#endif
