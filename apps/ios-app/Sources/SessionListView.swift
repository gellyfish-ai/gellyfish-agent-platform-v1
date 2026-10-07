import SwiftUI

enum SessionLiveFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case live = "Live"
    case idle = "Idle"
    var id: Self { self }
}

struct SessionListView: View {
    @AppStorage("serverURL") private var serverURL = "http://10.0.0.1:3000"
    @State private var sessions: [Session] = []
    @State private var agentHealth: [AgentHealth] = []
    @State private var searchText = ""
    @State private var liveFilter: SessionLiveFilter = .all
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showNewChat = false
    @State private var profiles: [Profile] = []

    var filteredSessions: [Session] {
        let sorted = sessions.sorted { a, b in
            (a.lastActivityDate ?? .distantPast) > (b.lastActivityDate ?? .distantPast)
        }
        let bySearch = searchText.isEmpty
            ? sorted
            : sorted.filter { $0.displayName.localizedCaseInsensitiveContains(searchText) }
        switch liveFilter {
        case .all:
            return bySearch
        case .live:
            return bySearch.filter { agentHealthForSession($0)?.process_alive == true }
        case .idle:
            return bySearch.filter { agentHealthForSession($0)?.process_alive != true }
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !sessions.isEmpty {
                    Picker("Filter", selection: $liveFilter) {
                        ForEach(SessionLiveFilter.allCases) { f in
                            Text(f.rawValue).tag(f)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
                }

                Group {
                    if isLoading && sessions.isEmpty {
                        ProgressView("Loading sessions...")
                    } else if let error = errorMessage, sessions.isEmpty {
                        ContentUnavailableView {
                            Label("Connection Error", systemImage: "wifi.slash")
                        } description: {
                            Text(error)
                        } actions: {
                            Button("Retry") { Task { await loadData() } }
                        }
                    } else if sessions.isEmpty {
                        ContentUnavailableView {
                            Label("No Chats", systemImage: "bubble.left.and.bubble.right")
                        } description: {
                            Text("Start a conversation from the web UI")
                        }
                    } else if filteredSessions.isEmpty {
                        ContentUnavailableView {
                            Label("No \(liveFilter.rawValue) Chats", systemImage: "line.3.horizontal.decrease.circle")
                        } description: {
                            Text(liveFilter == .live
                                 ? "No chats currently have a running process."
                                 : "All chats currently have a running process.")
                        }
                    } else {
                        List(filteredSessions) { session in
                            NavigationLink(value: session) {
                                SessionRow(session: session, agentHealth: agentHealthForSession(session))
                            }
                        }
                        .listStyle(.plain)
                        .refreshable { await loadData() }
                    }
                }
            }
            .navigationTitle("Chats")
            .searchable(text: $searchText, prompt: "Search agents")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task {
                            let api = APIService(baseURL: serverURL)
                            profiles = (try? await api.fetchProfiles()) ?? []
                            showNewChat = true
                        }
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 22))
                    }
                }
            }
            .sheet(isPresented: $showNewChat) {
                ProfilePickerSheet(profiles: profiles, serverURL: serverURL) { session in
                    showNewChat = false
                    // Reload to show the new session
                    Task { await loadData() }
                }
            }
            .navigationDestination(for: Session.self) { session in
                ChatView(
                    session: session,
                    agentHealth: agentHealthForSession(session),
                    serverURL: serverURL
                )
            }
        }
        .task { await loadData() }
    }

    private func agentHealthForSession(_ session: Session) -> AgentHealth? {
        agentHealth.first { $0.session_id == session.id }
    }

    private func loadData() async {
        isLoading = true
        errorMessage = nil
        let api = APIService(baseURL: serverURL)
        do {
            async let sessionsTask = api.fetchSessions()
            async let healthTask = api.fetchAgentHealth()
            let (s, h) = try await (sessionsTask, healthTask)
            sessions = s
            agentHealth = h
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - Session Row

struct SessionRow: View {
    let session: Session
    let agentHealth: AgentHealth?

    var body: some View {
        HStack(spacing: 12) {
            // Agent icon with status dot
            ZStack(alignment: .bottomTrailing) {
                Text(session.icon)
                    .font(.system(size: 32))
                    .frame(width: 44, height: 44)

                Circle()
                    .fill(statusColor)
                    .frame(width: 12, height: 12)
                    .overlay(Circle().stroke(.background, lineWidth: 2))
                    .offset(x: 2, y: 2)
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(session.displayName)
                        .font(.headline)
                        .lineLimit(1)
                    if let crewName = agentHealth?.crews?.first?.name {
                        Text(crewName)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(.quaternary)
                            .clipShape(Capsule())
                            .lineLimit(1)
                    }
                    Spacer()
                    Text(session.relativeTime)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text(session.preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }

    private var statusColor: Color {
        guard let health = agentHealth else { return .gray }
        if health.isActive { return .green }
        if health.isIdle { return .yellow }
        return .gray
    }
}

// MARK: - Profile Picker Sheet

struct ProfilePickerSheet: View {
    let profiles: [Profile]
    let serverURL: String
    let onSessionCreated: (Session?) -> Void

    var body: some View {
        NavigationView {
            List(profiles) { profile in
                Button {
                    onSessionCreated(nil)
                } label: {
                    HStack(spacing: 12) {
                        Text(profile.icon)
                            .font(.system(size: 32))
                            .frame(width: 44, height: 44)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(profile.name)
                                .font(.headline)
                                .foregroundStyle(.primary)
                            let active = profile.active_agents ?? 0
                            let total = profile.total_agents ?? 0
                            Text("\(active)/\(total) agents")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .listStyle(.plain)
            .navigationTitle("New Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onSessionCreated(nil) }
                }
            }
        }
    }
}
