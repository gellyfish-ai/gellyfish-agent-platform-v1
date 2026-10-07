import Foundation

class APIService: ObservableObject {
    let baseURL: String

    init(baseURL: String) {
        self.baseURL = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    func fetchSessions() async throws -> [Session] {
        let url = URL(string: "\(baseURL)/api/sessions")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let response = try JSONDecoder().decode(SessionResponse.self, from: data)
        return response.sessions
    }

    func fetchAgentHealth() async throws -> [AgentHealth] {
        let url = URL(string: "\(baseURL)/api/agents/health")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let response = try JSONDecoder().decode(AgentsHealthResponse.self, from: data)
        return response.agents
    }

    func fetchCrews() async throws -> [Crew] {
        let url = URL(string: "\(baseURL)/api/crews")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let response = try JSONDecoder().decode(CrewsResponse.self, from: data)
        return response.crews
    }

    func fetchCrewDetail(id: String) async throws -> CrewDetailResponse {
        let url = URL(string: "\(baseURL)/api/crews/\(id)")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(CrewDetailResponse.self, from: data)
    }

    func fetchModels() async throws -> ModelsResponse {
        let url = URL(string: "\(baseURL)/api/models")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(ModelsResponse.self, from: data)
    }

    func updateProfileModel(profileId: String, model: String?) async throws {
        let url = URL(string: "\(baseURL)/api/profiles/\(profileId)")!
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any?] = ["model": model]
        request.httpBody = try JSONSerialization.data(withJSONObject: body.compactMapValues { $0 ?? NSNull() })
        let (_, _) = try await URLSession.shared.data(for: request)
    }

    func fetchProfiles() async throws -> [Profile] {
        let url = URL(string: "\(baseURL)/api/profiles")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let response = try JSONDecoder().decode(ProfilesResponse.self, from: data)
        return response.profiles
    }

    func fetchSessionFiles(conversationId: String) async throws -> [SessionFile] {
        let url = URL(string: "\(baseURL)/api/conversations/\(conversationId)/session-files")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let response = try JSONDecoder().decode(SessionFilesResponse.self, from: data)
        return response.sessions
    }

    func switchSession(conversationId: String, sessionId: String) async throws {
        let url = URL(string: "\(baseURL)/api/conversations/\(conversationId)/switch-session")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["sessionId": sessionId])
        let (_, _) = try await URLSession.shared.data(for: request)
    }

    func stopSession(sessionId: String) async throws {
        let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/stop")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let (_, _) = try await URLSession.shared.data(for: request)
    }

    func deleteSession(sessionId: String) async throws {
        let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)")!
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        let (_, _) = try await URLSession.shared.data(for: request)
    }

    func updateCrew(id: String, name: String?, icon: String?) async throws {
        let url = URL(string: "\(baseURL)/api/crews/\(id)")!
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let icon { body["icon"] = icon }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, _) = try await URLSession.shared.data(for: request)
    }

    func updateConversationIssue(conversationId: String, issueNumber: Int?) async throws {
        let url = URL(string: "\(baseURL)/api/conversations/\(conversationId)")!
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any?] = ["issue_number": issueNumber]
        request.httpBody = try JSONSerialization.data(withJSONObject: body.compactMapValues { $0 ?? NSNull() })
        let (_, _) = try await URLSession.shared.data(for: request)
    }
}
