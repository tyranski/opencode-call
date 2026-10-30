import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

public struct HTTP: @unchecked Sendable {
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    private let transport: Transport
    public init(transport: Transport? = nil) {
        if let transport { self.transport = transport; return }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        let session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
        self.transport = { request in
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse else { throw CallError.message("Invalid HTTP response") }
            return (data, response)
        }
    }

    public func send(_ request: URLRequest, service: String) async throws -> JSON {
        let (data, response) = try await transport(request)
        guard (200..<300).contains(response.statusCode) else {
            if service == "ElevenLabs", let body = try? JSON.decode(data),
               body["detail"]["status"].string == "missing_permissions" {
                throw CallError.message("Enable ElevenLabs Agents write permission (convai_write) for your API key.")
            }
            throw CallError.message("\(service) returned HTTP \(response.statusCode). Check the server address, credentials, and permissions.")
        }
        return data.isEmpty ? .null : try JSON.decode(data)
    }
}

public struct OpenCodeClient: Sendable {
    public let settings: ConnectionSettings
    private let http: HTTP
    public init(settings: ConnectionSettings, http: HTTP = HTTP()) {
        self.settings = settings; self.http = http
    }

    public func request(_ path: String, method: String = "GET", body: JSON? = nil) async throws -> JSON {
        guard var url = URLComponents(string: settings.serverURL),
              ["http", "https"].contains(url.scheme ?? ""), url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            throw CallError.message("Enter the OpenCode server origin, e.g. https://pc.tailnet.ts.net, without credentials or a path.")
        }
        url.path = path
        if !settings.directory.isEmpty { url.queryItems = [URLQueryItem(name: "directory", value: settings.directory)] }
        guard let address = url.url else { throw CallError.message("Invalid OpenCode URL") }
        var request = URLRequest(url: address)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !settings.password.isEmpty {
            let credentials = Data("\(settings.username):\(settings.password)".utf8).base64EncodedString()
            request.setValue("Basic \(credentials)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await http.send(request, service: "OpenCode")
    }

    public func health() async throws -> JSON { try await request("/global/health") }
    public func sessions() async throws -> [CodeSession] {
        let result = try await request("/session")
        return try JSONDecoder().decode([CodeSession].self, from: JSONEncoder().encode(result))
    }

    public func snapshot(_ sessionID: String) async throws -> Snapshot {
        try Self.validateID(sessionID, prefix: "ses")
        async let session = request("/session/\(sessionID)")
        async let statuses = request("/session/status")
        async let messages = request("/session/\(sessionID)/message")
        async let permissions = request("/permission")
        async let questions = request("/question")
        let result = try await (session, statuses, messages, permissions, questions)
        return Snapshot(sessionID: sessionID, title: result.0["title"].string ?? sessionID,
                        status: result.1[sessionID]["type"].string ?? "idle", messages: result.2.array,
                        permissions: result.3.array.filter { $0["sessionID"].string == sessionID },
                        questions: result.4.array.filter { $0["sessionID"].string == sessionID })
    }

    public func prompt(_ sessionID: String, text: String, messageID: String, agent: String) async throws {
        try Self.validateID(sessionID, prefix: "ses")
        _ = try await request("/session/\(sessionID)/prompt_async", method: "POST", body: .object([
            "messageID": .string(messageID), "agent": .string(agent),
            "parts": .array([.object(["type": .string("text"), "text": .string(text)])])
        ]))
    }

    public static func validateID(_ id: String, prefix: String) throws {
        guard id.hasPrefix(prefix), id.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-" }) else {
            throw CallError.message("Invalid \(prefix) identifier")
        }
    }
}

public enum ElevenLabsToken {
    public static func fetch(settings: ConnectionSettings, http: HTTP = HTTP()) async throws -> String {
        guard !settings.elevenLabsKey.isEmpty, !settings.agentID.isEmpty else {
            throw CallError.message("Enter your own ElevenLabs API key and agent ID in Settings.")
        }
        var url = URLComponents(string: "https://api.elevenlabs.io/v1/convai/conversation/token")!
        url.queryItems = [URLQueryItem(name: "agent_id", value: settings.agentID)]
        var request = URLRequest(url: url.url!)
        request.setValue(settings.elevenLabsKey, forHTTPHeaderField: "xi-api-key")
        let response = try await http.send(request, service: "ElevenLabs")
        guard let token = response["token"].string, !token.isEmpty else { throw CallError.message("ElevenLabs returned no token") }
        return token
    }
}
