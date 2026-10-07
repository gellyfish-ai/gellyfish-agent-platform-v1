import Foundation

struct SessionResponse: Codable {
    let sessions: [Session]
}

struct Session: Codable, Identifiable, Hashable {
    static func == (lhs: Session, rhs: Session) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    let id: String
    let firstMessage: String?
    let firstReply: String?
    let lastMessage: String?
    let lastActivity: String?
    let messageCount: Int
    let cwd: String?
    let profileId: String?
    let profileName: String?
    let profileIcon: String?

    var lastActivityDate: Date? {
        guard let lastActivity else { return nil }
        // Try with fractional seconds first, then without
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: lastActivity) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: lastActivity)
    }

    var displayName: String {
        profileName ?? "Unknown"
    }

    var icon: String {
        profileIcon ?? "🤖"
    }

    var preview: String {
        lastMessage?.prefix(100).description ?? firstReply?.prefix(100).description ?? firstMessage?.prefix(100).description ?? ""
    }

    var relativeTime: String {
        guard let date = lastActivityDate else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - Session Files

struct SessionFilesResponse: Codable {
    let sessions: [SessionFile]
}

struct SessionFile: Codable, Identifiable {
    let sessionId: String
    let sizeMB: String
    let modifiedAt: String?
    let active: Bool
    let path: String?

    var id: String { sessionId }

    var shortId: String {
        String(sessionId.prefix(8))
    }

    var formattedDate: String {
        guard let modifiedAt else { return "" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: modifiedAt) {
            let relative = RelativeDateTimeFormatter()
            relative.unitsStyle = .abbreviated
            return relative.localizedString(for: date, relativeTo: Date())
        }
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: modifiedAt) {
            let relative = RelativeDateTimeFormatter()
            relative.unitsStyle = .abbreviated
            return relative.localizedString(for: date, relativeTo: Date())
        }
        return modifiedAt
    }
}

// MARK: - Crews

struct CrewsResponse: Codable {
    let crews: [Crew]
}

struct Crew: Codable, Identifiable, Hashable {
    static func == (lhs: Crew, rhs: Crew) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    let id: String
    let name: String
    let icon: String
    let lead_agent_id: String?
    let lead_name: String?
    let lead_icon: String?
    let member_count: Int?

    var displayIcon: String {
        // icon field may be an emoji or a lucide icon name — show emoji if it is one
        if let first = lead_icon, !first.isEmpty { return first }
        return "👥"
    }
}

struct CrewDetailResponse: Codable {
    let crew: CrewDetail
    let members: [CrewMember]
}

struct CrewDetail: Codable {
    let id: String
    let name: String
    let icon: String
    let lead_name: String?
    let lead_icon: String?
}

struct CrewMember: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let icon: String
    let added_at: String?
}

// MARK: - Models

struct ModelsResponse: Codable {
    let models: [ModelOption]
    let `default`: String
}

struct ModelOption: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let shortName: String
}

// MARK: - Profiles

struct ProfilesResponse: Codable {
    let profiles: [Profile]
}

struct Profile: Codable, Identifiable, Hashable {
    static func == (lhs: Profile, rhs: Profile) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    let id: String
    let name: String
    let icon: String
    let system_prompt: String?
    let workspace_dir: String?
    let session_id: String?
    let active_agents: Int?
    let total_agents: Int?
    let model: String?
    let crews: [ProfileCrew]?
    let mcps: [ProfileMCP]?
}

struct ProfileCrew: Codable, Identifiable {
    let id: String
    let name: String
    let icon: String
    let role: String?
}

struct ProfileMCP: Codable, Identifiable {
    var id: String
    let name: String
    let type: String
}

// MARK: - Agents

struct AgentsHealthResponse: Codable {
    let agents: [AgentHealth]
}

struct AgentCrew: Codable, Identifiable {
    let id: String
    let name: String
}

struct AgentHealth: Codable, Identifiable {
    let id: String
    let name: String
    let state: String
    let profile_id: String?
    let profile_name: String?
    let profile_icon: String?
    let conversation_id: String?
    let session_id: String?
    let issue_number: Int?
    let process_alive: Bool
    let process_pid: Int?
    let stale: Bool
    let model: String?
    let crews: [AgentCrew]?

    var isActive: Bool {
        state == "working" && process_alive
    }

    var isIdle: Bool {
        state == "idle" || (state == "working" && !process_alive)
    }
}
