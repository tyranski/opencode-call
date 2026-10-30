import Foundation

public enum CallError: LocalizedError {
    case message(String)
    public var errorDescription: String? {
        switch self { case .message(let value): return value }
    }
}

/// Lossless JSON at the OpenCode boundary; unknown server fields remain available.
public enum JSON: Codable, Equatable, Sendable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let result = try? value.decode(Bool.self) { self = .bool(result) }
        else if let result = try? value.decode(Double.self) { self = .number(result) }
        else if let result = try? value.decode(String.self) { self = .string(result) }
        else if let result = try? value.decode([JSON].self) { self = .array(result) }
        else { self = .object(try value.decode([String: JSON].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let x): try value.encode(x)
        case .array(let x): try value.encode(x)
        case .string(let x): try value.encode(x)
        case .number(let x): try value.encode(x)
        case .bool(let x): try value.encode(x)
        case .null: try value.encodeNil()
        }
    }

    public subscript(key: String) -> JSON {
        guard case .object(let values) = self else { return .null }
        return values[key] ?? .null
    }
    public var string: String? { if case .string(let value) = self { return value }; return nil }
    public var array: [JSON] { if case .array(let value) = self { return value }; return [] }
    public func text() throws -> String { String(decoding: try JSONEncoder().encode(self), as: UTF8.self) }
    public static func decode(_ data: Data) throws -> JSON { try JSONDecoder().decode(JSON.self, from: data) }
}

public struct ConnectionSettings: Codable, Equatable, Sendable {
    public var serverURL = ""
    public var directory = ""
    public var username = "opencode"
    public var password = ""
    public var elevenLabsKey = ""
    public var agentID = ""
    public init() {}
    public var target: String { serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "|" + directory }
}

public struct CodeSession: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let directory: String?
}

public struct Snapshot: Sendable {
    public let sessionID: String
    public let title: String
    public let status: String
    public let messages: [JSON]
    public let permissions: [JSON]
    public let questions: [JSON]

    public static func isTerminal(_ message: JSON) -> Bool {
        let info = message["info"]
        return info["role"].string == "assistant" &&
            (info["error"] != .null || (info["time"]["completed"] != .null &&
                ["stop", "end_turn"].contains(info["finish"].string ?? "")))
    }
    public static func report(_ message: JSON?) -> String {
        message?["parts"].array.filter { $0["type"].string == "text" }
            .compactMap { $0["text"].string }.joined(separator: "\n") ?? ""
    }
    public var lastTerminal: JSON? { messages.last(where: Self.isTerminal) }
    public var progress: JSON {
        let actions = messages.flatMap { $0["parts"].array }.filter { $0["type"].string == "tool" }
            .suffix(5).map { part in JSON.object([
                "tool": part["tool"], "status": part["state"]["status"],
                "title": part["state"]["title"] == .null ? part["tool"] : part["state"]["title"]
            ]) }
        return .object([
            "sessionID": .string(sessionID), "title": .string(title), "status": .string(status),
            "observedAt": .string(ISO8601DateFormatter().string(from: Date())),
            "recentActions": .array(actions), "permissions": .array(permissions), "questions": .array(questions),
            "latestReport": .string(String(Self.report(lastTerminal).prefix(16000))),
            "note": .string("Observed activity; idle does not establish successful implementation or passing tests.")
        ])
    }
}
