import SwiftUI

struct ConversationInfoSheet: View {
    let session: Session
    let agentHealth: AgentHealth?
    let serverURL: String

    @State private var profile: Profile?
    @State private var isLoading = false
    @State private var copiedField: String?
    @State private var issueInput = ""
    @State private var currentIssue: Int?
    @State private var sessionFiles: [SessionFile] = []
    @State private var showStopConfirmation = false
    @State private var showDeleteConfirmation = false
    @State private var showModelChangeConfirmation = false
    @State private var pendingModel: String?
    @State private var isStopping = false
    @State private var isDeleting = false
    @State private var availableModels: [ModelOption] = []
    @State private var defaultModel = "sonnet"
    @State private var selectedModel: String = ""
    @State private var committedModel: String = ""
    var onSessionDeleted: (() -> Void)?
    var onSessionSwitched: ((String) -> Void)?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    private let repoURL = "https://github.com/gellyfish-ai/Gellyfish-Agent-Platform"

    var body: some View {
        NavigationView {
            Form {
                agentSection
                modelSection
                sessionSection
                sessionFilesSection
                actionsSection
                issueSection
                cliSection
                workspaceSection
                crewSection
                mcpSection
                systemPromptSection
            }
            .navigationTitle("Conversation Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            await loadProfile()
            await loadSessionFiles()
            await loadModels()
        }
        .onAppear {
            currentIssue = agentHealth?.issue_number
            if let issue = currentIssue { issueInput = "\(issue)" }
        }
    }

    // MARK: - Sections

    private var agentSection: some View {
        Section("Agent") {
            HStack(spacing: 12) {
                Text(session.icon)
                    .font(.system(size: 36))
                VStack(alignment: .leading) {
                    Text(agentHealth?.name ?? session.displayName)
                        .font(.headline)
                    if let profileName = session.profileName {
                        Text(profileName)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if let health = agentHealth {
                HStack {
                    Text("Status")
                    Spacer()
                    Circle()
                        .fill(health.isActive ? .green : health.isIdle ? .yellow : .gray)
                        .frame(width: 8, height: 8)
                    Text(health.state)
                        .foregroundStyle(.secondary)
                }

                if let pid = health.process_pid {
                    LabeledContent("PID", value: "\(pid)")
                }

                if let model = health.model {
                    LabeledContent("Model", value: model)
                }
            }

            // Connection status
            LabeledContent("Connection") {
                HStack(spacing: 4) {
                    Circle()
                        .fill(agentHealth?.process_alive == true ? .green : .gray)
                        .frame(width: 6, height: 6)
                    Text(agentHealth?.process_alive == true ? "Connected" : "Disconnected")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var modelSection: some View {
        if let profileId = session.profileId, !availableModels.isEmpty {
            Section("Model") {
                Picker("Model", selection: $selectedModel) {
                    Text("Default (\(defaultModel))").tag("")
                    ForEach(availableModels) { model in
                        Text(model.label).tag(model.id)
                    }
                }
                .onChange(of: selectedModel) { _, newValue in
                    guard newValue != committedModel else { return }
                    pendingModel = newValue
                    showModelChangeConfirmation = true
                }
                .alert("Change Model?", isPresented: $showModelChangeConfirmation) {
                    Button("Cancel", role: .cancel) {
                        selectedModel = committedModel
                    }
                    Button("Change & Restart") {
                        if let model = pendingModel {
                            committedModel = model
                            Task { await changeModel(profileId: profileId, model: model.isEmpty ? nil : model) }
                        }
                    }
                } message: {
                    Text("Changing model will restart this agent. The current process will be stopped and respawned with the new model.")
                }
            }
        }
    }

    private var sessionSection: some View {
        Section("Session") {
            // Session ID with copy
            HStack {
                Text(session.id)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                copyButton(value: session.id, field: "sessionId")
            }

            LabeledContent("Messages", value: "\(session.messageCount)")

            if !session.relativeTime.isEmpty {
                LabeledContent("Last Activity", value: session.relativeTime)
            }
        }
    }

    private var issueSection: some View {
        Section("Linked Issue") {
            if let issue = currentIssue {
                Button {
                    openURL(URL(string: "\(repoURL)/issues/\(issue)")!)
                } label: {
                    HStack {
                        Text("#\(issue)")
                            .font(.headline)
                        Spacer()
                        Image(systemName: "arrow.up.right.square")
                            .foregroundStyle(.blue)
                    }
                }
            } else {
                Text("No issue linked")
                    .foregroundStyle(.secondary)
            }

            if let conversationId = agentHealth?.conversation_id {
                HStack {
                    TextField("#", text: $issueInput)
                        .keyboardType(.numberPad)
                        .frame(width: 80)
                        .textFieldStyle(.roundedBorder)

                    Button("Set") {
                        guard let num = Int(issueInput) else { return }
                        Task { await setIssue(conversationId: conversationId, issue: num) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(issueInput.isEmpty)

                    if currentIssue != nil {
                        Button("Clear") {
                            Task { await setIssue(conversationId: conversationId, issue: nil) }
                        }
                        .buttonStyle(.bordered)
                        .tint(.red)
                    }
                }
            }
        }
    }

    private var cliSection: some View {
        Section("CLI") {
            let hint = "claude --resume \(session.id.prefix(8))..."
            HStack {
                Text(hint)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                copyButton(value: "claude --resume \(session.id)", field: "cli")
            }
        }
    }

    @ViewBuilder
    private var workspaceSection: some View {
        if let dir = profile?.workspace_dir {
            Section("Workspace") {
                Text(dir)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var crewSection: some View {
        if let crews = profile?.crews, !crews.isEmpty {
            Section("Crews") {
                ForEach(crews) { crew in
                    HStack(spacing: 8) {
                        Text(crew.name)
                        Spacer()
                        Text(crew.role ?? "member")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var mcpSection: some View {
        if let mcps = profile?.mcps, !mcps.isEmpty {
            Section("MCPs") {
                ForEach(mcps) { mcp in
                    HStack {
                        Text(mcp.name)
                        Spacer()
                        Text(mcp.type)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.quaternary)
                            .clipShape(Capsule())
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var systemPromptSection: some View {
        if let prompt = profile?.system_prompt, !prompt.isEmpty {
            Section("System Prompt") {
                Text(prompt)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var sessionFilesSection: some View {
        if let conversationId = agentHealth?.conversation_id {
            Section("Session Files") {
                if sessionFiles.isEmpty {
                    Text("No session files")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(sessionFiles) { file in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 4) {
                                    Text(file.shortId + "...")
                                        .font(.system(.caption, design: .monospaced))
                                    if file.active {
                                        Text("active")
                                            .font(.caption2)
                                            .foregroundStyle(.green)
                                    }
                                }
                                Text("\(file.sizeMB)MB · \(file.formattedDate)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if !file.active {
                                Button("Switch") {
                                    Task {
                                        await switchToSession(conversationId: conversationId, sessionId: file.sessionId)
                                    }
                                }
                                .font(.caption)
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                }
            }
        }
    }

    private var actionsSection: some View {
        Section("Actions") {
            if agentHealth?.process_alive == true {
                Button(role: .destructive) {
                    showStopConfirmation = true
                } label: {
                    HStack {
                        Text(isStopping ? "Stopping..." : "Stop Process")
                        Spacer()
                        Image(systemName: "stop.circle")
                    }
                }
                .disabled(isStopping)
                .alert("Stop Process?", isPresented: $showStopConfirmation) {
                    Button("Cancel", role: .cancel) { }
                    Button("Stop", role: .destructive) { Task { await stopProcess() } }
                } message: {
                    Text("This will terminate the running Claude process.")
                }
            }

            Button(role: .destructive) {
                showDeleteConfirmation = true
            } label: {
                HStack {
                    Text(isDeleting ? "Deleting..." : "Delete Session")
                    Spacer()
                    Image(systemName: "trash")
                }
            }
            .disabled(isDeleting)
            .alert("Delete Session?", isPresented: $showDeleteConfirmation) {
                Button("Cancel", role: .cancel) { }
                Button("Delete", role: .destructive) { Task { await deleteCurrentSession() } }
            } message: {
                Text("This will delete the session history. Are you sure?")
            }
        }
    }

    // MARK: - Helpers

    private func copyButton(value: String, field: String) -> some View {
        Button {
            UIPasteboard.general.string = value
            copiedField = field
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                copiedField = nil
            }
        } label: {
            Image(systemName: copiedField == field ? "checkmark" : "doc.on.doc")
                .foregroundStyle(copiedField == field ? .green : .blue)
        }
        .buttonStyle(.plain)
    }

    private func setIssue(conversationId: String, issue: Int?) async {
        do {
            try await APIService(baseURL: serverURL).updateConversationIssue(
                conversationId: conversationId, issueNumber: issue
            )
            currentIssue = issue
            issueInput = issue.map { "\($0)" } ?? ""
        } catch {
            print("[ConversationInfoSheet] setIssue error: \(error)")
        }
    }

    private func loadProfile() async {
        guard let profileId = session.profileId else { return }
        isLoading = true
        do {
            let profiles = try await APIService(baseURL: serverURL).fetchProfiles()
            profile = profiles.first { $0.id == profileId }
        } catch {
            print("[ConversationInfoSheet] Error: \(error)")
        }
        isLoading = false
    }

    private func loadSessionFiles() async {
        guard let conversationId = agentHealth?.conversation_id else { return }
        do {
            sessionFiles = try await APIService(baseURL: serverURL).fetchSessionFiles(conversationId: conversationId)
        } catch {
            print("[ConversationInfoSheet] fetchSessionFiles error: \(error)")
        }
    }

    private func switchToSession(conversationId: String, sessionId: String) async {
        do {
            try await APIService(baseURL: serverURL).switchSession(conversationId: conversationId, sessionId: sessionId)
            onSessionSwitched?(sessionId)
            dismiss()
        } catch {
            print("[ConversationInfoSheet] switchSession error: \(error)")
        }
    }

    private func stopProcess() async {
        isStopping = true
        do {
            try await APIService(baseURL: serverURL).stopSession(sessionId: session.id)
        } catch {
            print("[ConversationInfoSheet] stopSession error: \(error)")
        }
        isStopping = false
    }

    private func loadModels() async {
        do {
            let response = try await APIService(baseURL: serverURL).fetchModels()
            availableModels = response.models
            defaultModel = response.default
            // Initialize selectedModel from health data (resolved model maps to profile's raw model)
            // Use profile_model if available, otherwise empty = default
            if let profileId = session.profileId {
                let profiles = try await APIService(baseURL: serverURL).fetchProfiles()
                if let profile = profiles.first(where: { $0.id == profileId }) {
                    let model = profile.model ?? ""
                    committedModel = model
                    selectedModel = model
                }
            }
        } catch {
            print("[ConversationInfoSheet] loadModels error: \(error)")
        }
    }

    private func changeModel(profileId: String, model: String?) async {
        do {
            try await APIService(baseURL: serverURL).updateProfileModel(profileId: profileId, model: model)
            // Stop the current session to force respawn with new model
            try await APIService(baseURL: serverURL).stopSession(sessionId: session.id)
        } catch {
            print("[ConversationInfoSheet] changeModel error: \(error)")
        }
    }

    private func deleteCurrentSession() async {
        isDeleting = true
        do {
            try await APIService(baseURL: serverURL).deleteSession(sessionId: session.id)
            onSessionDeleted?()
            dismiss()
        } catch {
            print("[ConversationInfoSheet] deleteSession error: \(error)")
        }
        isDeleting = false
    }
}
