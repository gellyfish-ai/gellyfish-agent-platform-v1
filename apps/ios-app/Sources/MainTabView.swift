import SwiftUI

struct MainTabView: View {
    @State private var selectedTab = 2 // Chats is default

    var body: some View {
        TabView(selection: $selectedTab) {
            CrewsView()
                .tabItem {
                    Label("Crews", systemImage: "person.2.fill")
                }
                .tag(0)

            ProfilesView()
                .tabItem {
                    Label("Profiles", systemImage: "person.crop.rectangle.stack.fill")
                }
                .tag(1)

            SessionListView()
                .tabItem {
                    Label("Chats", systemImage: "bubble.left.and.bubble.right.fill")
                }
                .tag(2)

            MoreView()
                .tabItem {
                    Label("More", systemImage: "ellipsis")
                }
                .tag(3)
        }
    }
}
