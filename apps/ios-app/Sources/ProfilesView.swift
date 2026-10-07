import SwiftUI

struct ProfilesView: View {
    @AppStorage("serverURL") private var serverURL = "http://10.0.0.1:3000"
    @State private var profiles: [Profile] = []
    @State private var agentHealth: [AgentHealth] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && profiles.isEmpty {
                    ProgressView("Loading profiles...")
                } else if let error = errorMessage, profiles.isEmpty {
                    ContentUnavailableView {
                        Label("Connection Error", systemImage: "wifi.slash")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { Task { await loadData() } }
                    }
                } else if profiles.isEmpty {
                    ContentUnavailableView {
                        Label("No Profiles", systemImage: "person.crop.rectangle.stack.fill")
                    } description: {
                        Text("No profiles configured yet")
                    }
                } else {
                    List(profiles) { profile in
                        NavigationLink(value: profile) {
                            ProfileRow(profile: profile, agentHealth: agentHealth)
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await loadData() }
                }
            }
            .navigationTitle("Profiles")
            .navigationDestination(for: Profile.self) { profile in
                ProfileDetailView(profile: profile, agentHealth: agentHealth, serverURL: serverURL)
            }
            .navigationDestination(for: Session.self) { session in
                ChatView(session: session, agentHealth: nil, serverURL: serverURL)
            }
        }
        .task { await loadData() }
    }

    private func loadData() async {
        isLoading = true
        errorMessage = nil
        let api = APIService(baseURL: serverURL)
        do {
            async let profilesTask = api.fetchProfiles()
            async let healthTask = api.fetchAgentHealth()
            let (p, h) = try await (profilesTask, healthTask)
            profiles = p
            agentHealth = h
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

struct ProfileRow: View {
    let profile: Profile
    let agentHealth: [AgentHealth]

    var body: some View {
        HStack(spacing: 12) {
            Text(profile.icon)
                .font(.system(size: 32))
                .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: 3) {
                Text(profile.name)
                    .font(.headline)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    let active = profile.active_agents ?? 0
                    let total = profile.total_agents ?? 0
                    if total > 0 {
                        Circle()
                            .fill(active > 0 ? .green : .gray)
                            .frame(width: 8, height: 8)
                        Text("\(active)/\(total) agents active")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("No agents")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Profile Detail

struct ProfileDetailView: View {
    let profile: Profile
    let agentHealth: [AgentHealth]
    let serverURL: String

    @State private var availableModels: [ModelOption] = []
    @State private var defaultModel = "sonnet"
    @State private var selectedModel: String = ""
    @State private var isSavingModel = false

    var profileAgents: [AgentHealth] {
        agentHealth.filter { $0.profile_id == profile.id }
    }

    var body: some View {
        List {
            Section("Profile") {
                HStack(spacing: 12) {
                    Text(profile.icon)
                        .font(.system(size: 40))
                    VStack(alignment: .leading) {
                        Text(profile.name)
                            .font(.title2.bold())
                        let active = profile.active_agents ?? 0
                        let total = profile.total_agents ?? 0
                        Text("\(active) active, \(total) total agents")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !availableModels.isEmpty {
                Section("Model") {
                    Picker("Model", selection: $selectedModel) {
                        Text("Default (\(defaultModel))").tag("")
                        ForEach(availableModels) { model in
                            Text(model.label).tag(model.id)
                        }
                    }
                    .onChange(of: selectedModel) { _, newValue in
                        Task { await saveModel(newValue.isEmpty ? nil : newValue) }
                    }
                }
            }

            if !profileAgents.isEmpty {
                Section("Agents (\(profileAgents.count))") {
                    ForEach(profileAgents) { agent in
                        if let session = sessionForAgent(agent) {
                            NavigationLink(value: session) {
                                agentRow(agent: agent)
                            }
                        } else {
                            agentRow(agent: agent)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Section("Agents") {
                    Text("No agents spawned from this profile")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(profile.name)
        .task {
            selectedModel = profile.model ?? ""
            do {
                let response = try await APIService(baseURL: serverURL).fetchModels()
                availableModels = response.models
                defaultModel = response.default
            } catch {
                print("[ProfileDetailView] fetchModels error: \(error)")
            }
        }
    }

    private func saveModel(_ model: String?) async {
        isSavingModel = true
        do {
            try await APIService(baseURL: serverURL).updateProfileModel(profileId: profile.id, model: model)
        } catch {
            print("[ProfileDetailView] saveModel error: \(error)")
        }
        isSavingModel = false
    }

    private func agentRow(agent: AgentHealth) -> some View {
        HStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                Text(agent.profile_icon ?? "🤖")
                    .font(.system(size: 28))
                    .frame(width: 36, height: 36)
                Circle()
                    .fill(agent.isActive ? .green : agent.isIdle ? .yellow : .gray)
                    .frame(width: 10, height: 10)
                    .overlay(Circle().stroke(.background, lineWidth: 2))
                    .offset(x: 2, y: 2)
            }
            VStack(alignment: .leading) {
                Text(agent.name)
                    .font(.body)
                Text(agent.state)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func sessionForAgent(_ agent: AgentHealth) -> Session? {
        guard let sessionId = agent.session_id else { return nil }
        return Session(
            id: sessionId,
            firstMessage: nil,
            firstReply: nil,
            lastMessage: nil,
            lastActivity: nil,
            messageCount: 0,
            cwd: nil,
            profileId: agent.profile_id,
            profileName: agent.profile_name ?? agent.name,
            profileIcon: agent.profile_icon
        )
    }
}
