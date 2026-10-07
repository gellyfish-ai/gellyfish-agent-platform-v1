import SwiftUI

struct CrewsView: View {
    @AppStorage("serverURL") private var serverURL = "http://10.0.0.1:3000"
    @State private var crews: [Crew] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && crews.isEmpty {
                    ProgressView("Loading crews...")
                } else if let error = errorMessage, crews.isEmpty {
                    ContentUnavailableView {
                        Label("Connection Error", systemImage: "wifi.slash")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { Task { await loadData() } }
                    }
                } else if crews.isEmpty {
                    ContentUnavailableView {
                        Label("No Crews", systemImage: "person.2.fill")
                    } description: {
                        Text("No crews configured yet")
                    }
                } else {
                    List(crews) { crew in
                        NavigationLink(value: crew) {
                            CrewRow(crew: crew)
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await loadData() }
                }
            }
            .navigationTitle("Crews")
            .navigationDestination(for: Crew.self) { crew in
                CrewDetailView(crew: crew, serverURL: serverURL)
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
        do {
            crews = try await APIService(baseURL: serverURL).fetchCrews()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

struct CrewRow: View {
    let crew: Crew

    var body: some View {
        HStack(spacing: 12) {
            Text(crew.lead_icon ?? "👥")
                .font(.system(size: 32))
                .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: 3) {
                Text(crew.name)
                    .font(.headline)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    if let leadName = crew.lead_name {
                        Text("Lead: \(leadName)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let count = crew.member_count {
                        Text("\(count) members")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Crew Detail

struct CrewDetailView: View {
    let crew: Crew
    let serverURL: String

    @State private var detail: CrewDetailResponse?
    @State private var agentHealth: [AgentHealth] = []
    @State private var isLoading = false
    @State private var editedName: String = ""
    @State private var editedIcon: String = ""
    @State private var isEditingName = false
    @State private var isSaving = false

    var body: some View {
        Group {
            if isLoading && detail == nil {
                ProgressView("Loading...")
            } else if let detail {
                List {
                    // Crew settings
                    Section("Crew Settings") {
                        HStack {
                            Text("Icon")
                            Spacer()
                            TextField("Emoji", text: $editedIcon)
                                .multilineTextAlignment(.trailing)
                                .frame(width: 50)
                                .onChange(of: editedIcon) { _, newValue in
                                    // Keep only the first character (emoji)
                                    if newValue.count > 1 {
                                        editedIcon = String(newValue.suffix(1))
                                    }
                                }
                        }

                        HStack {
                            Text("Name")
                            Spacer()
                            if isEditingName {
                                TextField("Crew name", text: $editedName)
                                    .multilineTextAlignment(.trailing)
                                    .onSubmit { Task { await saveCrew() } }
                            } else {
                                Button(editedName) {
                                    isEditingName = true
                                }
                                .foregroundStyle(.primary)
                            }
                        }

                        Button {
                            Task { await saveCrew() }
                        } label: {
                            HStack {
                                Text(isSaving ? "Saving..." : "Save Changes")
                                Spacer()
                                if isSaving {
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(isSaving || (editedName == crew.name && editedIcon == crew.icon))
                    }

                    // Lead — tappable if has session
                    if let leadSession = sessionForAgent(crew.lead_agent_id) {
                        Section("Lead") {
                            NavigationLink(value: leadSession) {
                                leadRow(detail: detail)
                            }
                        }
                    } else {
                        Section("Lead") {
                            leadRow(detail: detail)
                        }
                    }

                    Section("Members (\(detail.members.count))") {
                        ForEach(detail.members) { member in
                            if let session = sessionForProfile(member.id) {
                                NavigationLink(value: session) {
                                    memberRow(member: member)
                                }
                            } else {
                                memberRow(member: member)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            } else {
                ContentUnavailableView("Error", systemImage: "exclamationmark.triangle")
            }
        }
        .navigationTitle(editedName.isEmpty ? crew.name : editedName)
        .task {
            editedName = crew.name
            editedIcon = crew.icon
            await loadDetail()
        }
    }

    private func leadRow(detail: CrewDetailResponse) -> some View {
        HStack(spacing: 12) {
            Text(detail.crew.lead_icon ?? "👤")
                .font(.system(size: 28))
            Text(detail.crew.lead_name ?? "Unknown")
                .font(.headline)
        }
    }

    private func memberRow(member: CrewMember) -> some View {
        HStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                Text(member.icon)
                    .font(.system(size: 28))
                    .frame(width: 36, height: 36)
                Circle()
                    .fill(statusColor(for: member))
                    .frame(width: 10, height: 10)
                    .overlay(Circle().stroke(.background, lineWidth: 2))
                    .offset(x: 2, y: 2)
            }
            VStack(alignment: .leading) {
                Text(member.name)
                    .font(.body)
                if let health = agentHealth.first(where: { $0.profile_id == member.id }) {
                    Text(health.state)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private func sessionForAgent(_ agentId: String?) -> Session? {
        guard let agentId else { return nil }
        guard let health = agentHealth.first(where: { $0.id == agentId }),
              let sessionId = health.session_id else { return nil }
        return Session(
            id: sessionId,
            firstMessage: nil,
            firstReply: nil,
            lastMessage: nil,
            lastActivity: nil,
            messageCount: 0,
            cwd: nil,
            profileId: health.profile_id,
            profileName: health.name,
            profileIcon: health.profile_icon
        )
    }

    private func sessionForProfile(_ profileId: String?) -> Session? {
        guard let profileId else { return nil }
        guard let health = agentHealth.first(where: { $0.profile_id == profileId }),
              let sessionId = health.session_id else { return nil }
        return Session(
            id: sessionId,
            firstMessage: nil,
            firstReply: nil,
            lastMessage: nil,
            lastActivity: nil,
            messageCount: 0,
            cwd: nil,
            profileId: profileId,
            profileName: health.profile_name ?? health.name,
            profileIcon: health.profile_icon
        )
    }

    private func statusColor(for member: CrewMember) -> Color {
        if let health = agentHealth.first(where: { $0.profile_id == member.id }) {
            if health.isActive { return .green }
            if health.isIdle { return .yellow }
        }
        return .gray
    }

    private func saveCrew() async {
        isSaving = true
        isEditingName = false
        do {
            let nameToSave = editedName != crew.name ? editedName : nil
            let iconToSave = editedIcon != crew.icon ? editedIcon : nil
            if nameToSave != nil || iconToSave != nil {
                try await APIService(baseURL: serverURL).updateCrew(id: crew.id, name: nameToSave, icon: iconToSave)
            }
        } catch {
            print("[CrewDetailView] saveCrew error: \(error)")
        }
        isSaving = false
    }

    private func loadDetail() async {
        isLoading = true
        let api = APIService(baseURL: serverURL)
        do {
            async let detailTask = api.fetchCrewDetail(id: crew.id)
            async let healthTask = api.fetchAgentHealth()
            let (d, h) = try await (detailTask, healthTask)
            detail = d
            agentHealth = h
        } catch {
            print("[CrewDetailView] Error: \(error)")
        }
        isLoading = false
    }
}
