import Foundation
import Security
import CryptoKit
import AppKit

// MARK: - JSON-RPC Types

struct JSONRPCRequest: Codable {
    let jsonrpc: String
    let id: RequestID?
    let method: String
    let params: JSONValue?
}

struct JSONRPCResponse: Codable {
    let jsonrpc: String = "2.0"
    let id: RequestID?
    let result: JSONValue?
    let error: JSONRPCError?
}

struct JSONRPCError: Codable {
    let code: Int
    let message: String
}

enum RequestID: Codable, Equatable {
    case string(String)
    case int(Int)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let intValue = try? container.decode(Int.self) {
            self = .int(intValue)
        } else if let stringValue = try? container.decode(String.self) {
            self = .string(stringValue)
        } else {
            throw DecodingError.typeMismatch(RequestID.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Expected String or Int"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        }
    }
}

enum JSONValue: Codable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let int = try? container.decode(Int.self) {
            self = .int(int)
        } else if let double = try? container.decode(Double.self) {
            self = .double(double)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else if let object = try? container.decode([String: JSONValue].self) {
            self = .object(object)
        } else {
            throw DecodingError.typeMismatch(JSONValue.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unsupported JSON type"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    subscript(_ key: String) -> JSONValue? {
        if case .object(let dict) = self { return dict[key] }
        return nil
    }
}

// MARK: - Error Types

enum KeychainError: Error {
    case notFound(String)
    case authFailed(String)
    case interactionNotAllowed(String)
    case decodingFailed(String)
    case other(OSStatus, String)

    var message: String {
        switch self {
        case .notFound(let msg): return msg
        case .authFailed(let msg): return msg
        case .interactionNotAllowed(let msg): return msg
        case .decodingFailed(let msg): return msg
        case .other(_, let msg): return msg
        }
    }
}

// MARK: - CDP Helpers

func getPackageRoot() -> String {
    var execPath = CommandLine.arguments[0]
    if !execPath.hasPrefix("/") {
        execPath = FileManager.default.currentDirectoryPath + "/" + execPath
    }
    let execURL = URL(fileURLWithPath: execPath).standardizedFileURL
    // Binary is at .build/release/mcp-keychain-swift, package root is 3 levels up
    return execURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
}

func getSafeSnapshot(url: String? = nil) -> Result<String, KeychainError> {
    let packageRoot = getPackageRoot()
    let scriptPath = packageRoot + "/safe-snapshot.js"
    let nodeModulesPath = packageRoot + "/node_modules"

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", scriptPath]
    process.environment = ProcessInfo.processInfo.environment
    process.environment?["NODE_PATH"] = nodeModulesPath
    process.environment?["RECENT_FILLS_JSON"] = RecentFillsRegistry.shared.snapshotJSON()
    if let url = url {
        process.environment?["TARGET_URL"] = url
    }

    let pipe = Pipe()
    let errPipe = Pipe()
    process.standardOutput = pipe
    process.standardError = errPipe

    do {
        try process.run()
        process.waitUntilExit()

        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let errOutput = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""

        if process.terminationStatus == 0 {
            return .success(output)
        } else {
            return .failure(.other(OSStatus(process.terminationStatus), "Snapshot failed: \(errOutput.isEmpty ? output : errOutput)"))
        }
    } catch {
        return .failure(.other(-1, "Failed to run safe-snapshot script: \(error.localizedDescription)"))
    }
}

// MARK: - CDP Password Filler

func fillPasswordViaCDP(password: String, selector: String, url: String? = nil) -> Result<String, KeychainError> {
    let packageRoot = getPackageRoot()
    let scriptPath = packageRoot + "/fill-password.js"
    let nodeModulesPath = packageRoot + "/node_modules"

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", scriptPath, selector]
    process.environment = ProcessInfo.processInfo.environment
    process.environment?["SECRET_VALUE"] = password
    process.environment?["NODE_PATH"] = nodeModulesPath
    if let url = url {
        process.environment?["TARGET_URL"] = url
    }

    let pipe = Pipe()
    let errPipe = Pipe()
    process.standardOutput = pipe
    process.standardError = errPipe

    do {
        try process.run()
        process.waitUntilExit()

        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let errOutput = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""

        if process.terminationStatus == 0 && output.contains("OK") {
            // Record this URL+selector so a subsequent safe_snapshot redacts
            // the input even when the page hides its `password` type behind
            // CSS masking (idmsa pattern).
            if let url = url {
                RecentFillsRegistry.shared.record(url: url, selector: selector)
            }
            return .success("Password filled successfully")
        } else {
            return .failure(.other(OSStatus(process.terminationStatus), "CDP fill failed: \(errOutput.isEmpty ? output : errOutput)"))
        }
    } catch {
        return .failure(.other(-1, "Failed to run fill-password script: \(error.localizedDescription)"))
    }
}

// MARK: - Mobile Password Filler (WDA)

func fillPasswordViaMobile(password: String, x: Int, y: Int, udid: String) -> Result<String, KeychainError> {
    let packageRoot = getPackageRoot()
    let scriptPath = packageRoot + "/fill-mobile-password.js"
    let nodeModulesPath = packageRoot + "/node_modules"

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", scriptPath, String(x), String(y), udid]
    process.environment = ProcessInfo.processInfo.environment
    process.environment?["SECRET_VALUE"] = password
    process.environment?["NODE_PATH"] = nodeModulesPath

    let pipe = Pipe()
    let errPipe = Pipe()
    process.standardOutput = pipe
    process.standardError = errPipe

    do {
        try process.run()
        process.waitUntilExit()

        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let errOutput = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""

        if process.terminationStatus == 0 && output.contains("OK") {
            return .success("Password filled successfully on mobile device")
        } else {
            return .failure(.other(OSStatus(process.terminationStatus), "Mobile fill failed: \(errOutput.isEmpty ? output : errOutput)"))
        }
    } catch {
        return .failure(.other(-1, "Failed to run fill-mobile-password script: \(error.localizedDescription)"))
    }
}

// MARK: - Vault Integration

struct VaultCredential: Codable {
    let username: String
    let password: String
}

enum VaultError: Error {
    case requestFailed(String)
    case invalidResponse(String)
}

func fetchCredentialFromVault(token: String, credentialName: String) throws -> VaultCredential {
    let url = URL(string: "http://127.0.0.1:8205/execute")!
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.timeoutInterval = 10
    let body: [String: String] = ["token": token, "credential": credentialName, "action": "fill-credential"]
    request.httpBody = try JSONEncoder().encode(body)

    let semaphore = DispatchSemaphore(value: 0)
    var resultData: Data?
    var resultError: Error?
    var httpStatusCode: Int?

    let task = URLSession.shared.dataTask(with: request) { data, response, error in
        resultData = data
        resultError = error
        httpStatusCode = (response as? HTTPURLResponse)?.statusCode
        semaphore.signal()
    }
    task.resume()
    semaphore.wait()

    if let error = resultError {
        throw VaultError.requestFailed("Vault request failed: \(error.localizedDescription)")
    }
    guard let data = resultData else {
        throw VaultError.invalidResponse("No data from vault")
    }
    guard let status = httpStatusCode, (200..<300).contains(status) else {
        let body = String(data: data, encoding: .utf8) ?? "unknown"
        throw VaultError.requestFailed("Vault returned HTTP \(httpStatusCode ?? 0): \(body)")
    }
    return try JSONDecoder().decode(VaultCredential.self, from: data)
}

struct VaultListItem: Codable {
    let id: String
    let name: String
    let username: String?
    let login_uris: [String]
}

func fetchVaultCredentialList() throws -> [VaultListItem] {
    let url = URL(string: "http://127.0.0.1:8205/credentials/list")!
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.timeoutInterval = 10

    let semaphore = DispatchSemaphore(value: 0)
    var resultData: Data?
    var resultError: Error?
    var httpStatusCode: Int?

    let task = URLSession.shared.dataTask(with: request) { data, response, error in
        resultData = data
        resultError = error
        httpStatusCode = (response as? HTTPURLResponse)?.statusCode
        semaphore.signal()
    }
    task.resume()
    semaphore.wait()

    if let error = resultError {
        throw VaultError.requestFailed("Vault list request failed: \(error.localizedDescription)")
    }
    guard let data = resultData else {
        throw VaultError.invalidResponse("No data from vault list endpoint")
    }
    guard let status = httpStatusCode, (200..<300).contains(status) else {
        let body = String(data: data, encoding: .utf8) ?? "unknown"
        throw VaultError.requestFailed("Vault list returned HTTP \(httpStatusCode ?? 0): \(body)")
    }
    return try JSONDecoder().decode([VaultListItem].self, from: data)
}

// MARK: - MCP Server

class MCPServer {
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()

    init() {
        encoder.outputFormatting = []
    }

    func run() {
        // Read from stdin line by line
        while let line = readLine() {
            guard !line.isEmpty else { continue }

            do {
                let request = try decoder.decode(JSONRPCRequest.self, from: Data(line.utf8))
                let response = handleRequest(request)
                if let response = response {
                    let responseData = try encoder.encode(response)
                    if let responseString = String(data: responseData, encoding: .utf8) {
                        print(responseString)
                        fflush(stdout)
                    }
                }
            } catch {
                let errorResponse = JSONRPCResponse(
                    id: nil,
                    result: nil,
                    error: JSONRPCError(code: -32700, message: "Parse error: \(error.localizedDescription)")
                )
                if let responseData = try? encoder.encode(errorResponse),
                   let responseString = String(data: responseData, encoding: .utf8) {
                    print(responseString)
                    fflush(stdout)
                }
            }
        }
    }

    func handleRequest(_ request: JSONRPCRequest) -> JSONRPCResponse? {
        switch request.method {
        case "initialize":
            return handleInitialize(request)
        case "notifications/initialized":
            return nil // No response for notifications
        case "tools/list":
            return handleToolsList(request)
        case "tools/call":
            return handleToolsCall(request)
        default:
            return JSONRPCResponse(
                id: request.id,
                result: nil,
                error: JSONRPCError(code: -32601, message: "Method not found: \(request.method)")
            )
        }
    }

    func handleInitialize(_ request: JSONRPCRequest) -> JSONRPCResponse {
        let result: JSONValue = .object([
            "protocolVersion": .string("2024-11-05"),
            "capabilities": .object([
                "tools": .object([:])
            ]),
            "serverInfo": .object([
                "name": .string("mcp-keychain-swift"),
                "version": .string("1.0.0")
            ])
        ])
        return JSONRPCResponse(id: request.id, result: result, error: nil)
    }

    func handleToolsList(_ request: JSONRPCRequest) -> JSONRPCResponse {
        let tools: JSONValue = .object([
            "tools": .array([
                .object([
                    "name": .string("fill_password"),
                    "description": .string("Securely fill a password field in the browser. Fetches the credential from the Bitwarden vault (requires Face ID approval) and fills the specified element via CDP. Password never leaves this process — only success/failure is returned. SECURITY: after this call do NOT call browser_snapshot — it leaks plaintext passwords for inputs that mask via CSS (-webkit-text-security) instead of type=password. Use safe_snapshot instead."),
                    "inputSchema": .object([
                        "type": .string("object"),
                        "properties": .object([
                            "url": .object([
                                "type": .string("string"),
                                "description": .string("Website URL to find credentials for (e.g., https://www.example.com)")
                            ]),
                            "selector": .object([
                                "type": .string("string"),
                                "description": .string("CSS selector for the password input field (e.g., input[type=password])")
                            ]),
                            "credential": .object([
                                "type": .string("string"),
                                "description": .string("Bitwarden credential name (e.g. 'example-account'). Use list_credentials to see available names.")
                            ])
                        ]),
                        "required": .array([.string("url"), .string("selector"), .string("credential")])
                    ])
                ]),
                .object([
                    "name": .string("safe_snapshot"),
                    "description": .string("Take an accessibility snapshot of the current page with password field values redacted. ALWAYS use this — never browser_snapshot — after any fill_password / fill_mobile_password / fill_native_password call, and any time the page may contain a password input. Redacts <input type=password>, CSS-masked inputs (-webkit-text-security), inputs with autocomplete=current-password|new-password, and any input matching a recent fill (last 5 minutes)."),
                    "inputSchema": .object([
                        "type": .string("object"),
                        "properties": .object([:]),
                        "required": .array([])
                    ])
                ]),
                .object([
                    "name": .string("fill_mobile_password"),
                    "description": .string("Securely fill a password field on a connected iPhone. Fetches the credential from the Bitwarden vault (requires Face ID approval) and types it into the specified field coordinates via WebDriverAgent. Password never leaves this process — only success/failure is returned. SECURITY: after this call do NOT take an unredacted browser/screen snapshot of the device — use safe_snapshot when inspecting browser state on macOS, and avoid screenshotting the field on iOS until you navigate away."),
                    "inputSchema": .object([
                        "type": .string("object"),
                        "properties": .object([
                            "credential": .object([
                                "type": .string("string"),
                                "description": .string("Bitwarden credential name (e.g. 'example-account'). Use list_credentials to see available names.")
                            ]),
                            "x": .object([
                                "type": .string("number"),
                                "description": .string("X coordinate of the password field to tap")
                            ]),
                            "y": .object([
                                "type": .string("number"),
                                "description": .string("Y coordinate of the password field to tap")
                            ]),
                            "udid": .object([
                                "type": .string("string"),
                                "description": .string("Device UDID (optional, uses first connected device if omitted)")
                            ])
                        ]),
                        "required": .array([.string("credential"), .string("x"), .string("y")])
                    ])
                ]),
                .object([
                    "name": .string("fill_native_password"),
                    "description": .string("Securely fill a password into the frontmost native Mac app. Fetches the credential from the Bitwarden vault (requires Face ID approval) and pastes it via clipboard + Cmd+V. Clipboard is cleared after 2 seconds. Password never leaves this process — only success/failure is returned. SECURITY: do NOT screenshot the target window until you navigate away from the password field — Mac apps render plaintext like any other field."),
                    "inputSchema": .object([
                        "type": .string("object"),
                        "properties": .object([
                            "credential": .object([
                                "type": .string("string"),
                                "description": .string("Bitwarden credential name (e.g. 'example-account'). Use list_credentials to see available names.")
                            ])
                        ]),
                        "required": .array([.string("credential")])
                    ])
                ]),
                .object([
                    "name": .string("list_credentials"),
                    "description": .string("List all credentials in the Bitwarden vault. Returns names, usernames, and login URIs. Does NOT return passwords or any secret fields. No approval token needed — metadata only."),
                    "inputSchema": .object([
                        "type": .string("object"),
                        "properties": .object([:]),
                        "required": .array([])
                    ])
                ])
            ])
        ])
        return JSONRPCResponse(id: request.id, result: tools, error: nil)
    }

    func handleToolsCall(_ request: JSONRPCRequest) -> JSONRPCResponse {
        guard let params = request.params,
              case .object(let paramsDict) = params,
              let name = paramsDict["name"]?.stringValue else {
            return JSONRPCResponse(
                id: request.id,
                result: nil,
                error: JSONRPCError(code: -32602, message: "Invalid params: missing tool name")
            )
        }

        switch name {
        case "fill_password":
            return handleFillPassword(request)
        case "fill_mobile_password":
            return handleFillMobilePassword(request)
        case "fill_native_password":
            return handleFillNativePassword(request)
        case "safe_snapshot":
            return handleSafeSnapshot(request)
        case "list_credentials":
            return handleListCredentials(request)
        default:
            return JSONRPCResponse(
                id: request.id,
                result: nil,
                error: JSONRPCError(code: -32602, message: "Unknown tool: \(name)")
            )
        }
    }

    func handleFillPassword(_ request: JSONRPCRequest) -> JSONRPCResponse {
        guard let params = request.params,
              let arguments = params["arguments"],
              let url = arguments["url"]?.stringValue,
              let selector = arguments["selector"]?.stringValue else {
            return JSONRPCResponse(
                id: request.id,
                result: nil,
                error: JSONRPCError(code: -32602, message: "Invalid params: missing url or selector")
            )
        }

        guard let token = arguments["__approval_token"]?.stringValue else {
            return errorResponse(request, "Approval token required. Credential access requires Face ID approval — the __approval_token is provided by the gateway approval flow. Do not call this tool without going through the approval process.")
        }

        guard let credentialName = arguments["credential"]?.stringValue else {
            return errorResponse(request, "Missing credential name. Specify which Bitwarden credential to fill — use list_credentials to see available names.")
        }

        do {
            let cred = try fetchCredentialFromVault(token: token, credentialName: credentialName)
            let fillResult = fillPasswordViaCDP(password: cred.password, selector: selector, url: url)
            switch fillResult {
            case .success(let message):
                return textResponse(request, message)
            case .failure(let error):
                return errorResponse(request, "Fill error: \(error.message)")
            }
        } catch {
            return errorResponse(request, "Vault error: \(error)")
        }
    }

    func handleFillMobilePassword(_ request: JSONRPCRequest) -> JSONRPCResponse {
        guard let params = request.params,
              let arguments = params["arguments"] else {
            return errorResponse(request, "Invalid params")
        }

        guard let token = arguments["__approval_token"]?.stringValue else {
            return errorResponse(request, "Approval token required. Credential access requires Face ID approval — the __approval_token is provided by the gateway approval flow. Do not call this tool without going through the approval process.")
        }

        guard let credentialName = arguments["credential"]?.stringValue else {
            return errorResponse(request, "Missing credential name. Specify which Bitwarden credential to fill — use list_credentials to see available names.")
        }

        let x: Int
        let y: Int
        switch arguments["x"] {
        case .int(let val): x = val
        case .double(let val): x = Int(val)
        default: return errorResponse(request, "Invalid params: missing or invalid x coordinate")
        }
        switch arguments["y"] {
        case .int(let val): y = val
        case .double(let val): y = Int(val)
        default: return errorResponse(request, "Invalid params: missing or invalid y coordinate")
        }
        let udid = arguments["udid"]?.stringValue ?? ""

        do {
            let cred = try fetchCredentialFromVault(token: token, credentialName: credentialName)
            let fillResult = fillPasswordViaMobile(password: cred.password, x: x, y: y, udid: udid)
            switch fillResult {
            case .success(let message):
                return textResponse(request, message)
            case .failure(let error):
                return errorResponse(request, "Mobile fill error: \(error.message)")
            }
        } catch {
            return errorResponse(request, "Vault error: \(error)")
        }
    }

    func handleFillNativePassword(_ request: JSONRPCRequest) -> JSONRPCResponse {
        guard let params = request.params,
              let arguments = params["arguments"] else {
            return errorResponse(request, "Invalid params")
        }

        guard let token = arguments["__approval_token"]?.stringValue else {
            return errorResponse(request, "Approval token required. Credential access requires Face ID approval — the __approval_token is provided by the gateway approval flow. Do not call this tool without going through the approval process.")
        }

        guard let credentialName = arguments["credential"]?.stringValue else {
            return errorResponse(request, "Missing credential name. Specify which Bitwarden credential to fill — use list_credentials to see available names.")
        }

        do {
            let cred = try fetchCredentialFromVault(token: token, credentialName: credentialName)
            return fillPasswordViaNative(password: cred.password, request: request)
        } catch {
            return errorResponse(request, "Vault error: \(error)")
        }
    }

    private func fillPasswordViaNative(password: String, request: JSONRPCRequest) -> JSONRPCResponse {
        // 1. Set password on clipboard
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(password, forType: .string)

        // 2. Send Cmd+V to frontmost app via System Events
        let script = NSAppleScript(source: """
            tell application "System Events"
                keystroke "v" using command down
            end tell
        """)
        var errorInfo: NSDictionary?
        script?.executeAndReturnError(&errorInfo)

        if let errorInfo = errorInfo {
            // Clear clipboard even on error
            pasteboard.clearContents()
            let errMsg = errorInfo[NSAppleScript.errorMessage] as? String ?? "Unknown AppleScript error"
            return errorResponse(request, "Paste failed: \(errMsg)")
        }

        // 3. Wait 2 seconds then clear clipboard
        Thread.sleep(forTimeInterval: 2)
        pasteboard.clearContents()

        return textResponse(request, "Password pasted into frontmost app and clipboard cleared")
    }

    func handleSafeSnapshot(_ request: JSONRPCRequest) -> JSONRPCResponse {
        let result = getSafeSnapshot()

        switch result {
        case .success(let snapshot):
            let content: JSONValue = .object([
                "content": .array([
                    .object([
                        "type": .string("text"),
                        "text": .string(snapshot)
                    ])
                ])
            ])
            return JSONRPCResponse(id: request.id, result: content, error: nil)
        case .failure(let error):
            let content: JSONValue = .object([
                "content": .array([
                    .object([
                        "type": .string("text"),
                        "text": .string("Snapshot error: \(error.message)")
                    ])
                ]),
                "isError": .bool(true)
            ])
            return JSONRPCResponse(id: request.id, result: content, error: nil)
        }
    }

    func handleListCredentials(_ request: JSONRPCRequest) -> JSONRPCResponse {
        do {
            let credentials = try fetchVaultCredentialList()
            var lines: [String] = ["Vault credentials:\n"]
            lines.append("| Name | Username | URIs |")
            lines.append("|------|----------|------|")
            for cred in credentials {
                let uris = cred.login_uris.joined(separator: ", ")
                lines.append("| \(cred.name) | \(cred.username ?? "—") | \(uris) |")
            }
            lines.append("\nTotal: \(credentials.count) credentials")
            return textResponse(request, lines.joined(separator: "\n"))
        } catch {
            return errorResponse(request, "Vault error: \(error)")
        }
    }

    // MARK: - Response Helpers

    private func textResponse(_ request: JSONRPCRequest, _ text: String) -> JSONRPCResponse {
        let content: JSONValue = .object([
            "content": .array([
                .object([
                    "type": .string("text"),
                    "text": .string(text)
                ])
            ])
        ])
        return JSONRPCResponse(id: request.id, result: content, error: nil)
    }

    private func errorResponse(_ request: JSONRPCRequest, _ text: String) -> JSONRPCResponse {
        let content: JSONValue = .object([
            "content": .array([
                .object([
                    "type": .string("text"),
                    "text": .string(text)
                ])
            ]),
            "isError": .bool(true)
        ])
        return JSONRPCResponse(id: request.id, result: content, error: nil)
    }
}

// MARK: - Main

let server = MCPServer()
server.run()
