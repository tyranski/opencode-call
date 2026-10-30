import Foundation

public struct BuildRecord: Codable, Identifiable {
    public let id: String
    public let target: String
    public let sessionID: String
    public let text: String
    public var state: String
    public var messageID: String?
}

/// Single-owner journal. Persist intent before network submission; never replay an uncertain write.
@MainActor public final class NativeWorkflow {
    public let client: OpenCodeClient
    private let journalURL: URL
    public private(set) var records: [BuildRecord]
    public init(client: OpenCodeClient, journalURL: URL) throws {
        self.client = client; self.journalURL = journalURL
        if FileManager.default.fileExists(atPath: journalURL.path) {
            records = try JSONDecoder().decode([BuildRecord].self, from: Data(contentsOf: journalURL))
        } else { records = [] }
    }
    public static let active: Set<String> = ["dispatching", "uncertain", "submitted", "running", "waiting", "cancelling"]
    public var currentRecords: [BuildRecord] { records.filter { $0.target == client.settings.target } }
    private func save(_ record: BuildRecord) throws {
        var next = records.filter { $0.id != record.id }; next.append(record)
        try FileManager.default.createDirectory(at: journalURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(next).write(to: journalURL, options: .atomic)
        records = next
    }
    public func propose(sessionID: String, text: String) throws -> BuildRecord {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CallError.message("Task scope is required") }
        let record = BuildRecord(id: UUID().uuidString, target: client.settings.target, sessionID: sessionID, text: text, state: "proposed")
        try save(record); return record
    }
    public func record(_ id: String) throws -> BuildRecord {
        guard let record = currentRecords.first(where: { $0.id == id }) else { throw CallError.message("Unknown task for this server/project") }
        return record
    }
    public func authorize(_ id: String) async throws -> BuildRecord {
        var task = try record(id)
        guard task.state == "proposed", !currentRecords.contains(where: { $0.sessionID == task.sessionID && Self.active.contains($0.state) }) else {
            throw CallError.message("A task is already active or its submission needs reconciliation")
        }
        task.state = "dispatching"
        task.messageID = "msg_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        try save(task)
        do {
            let snapshot = try await client.snapshot(task.sessionID)
            guard snapshot.status == "idle", snapshot.permissions.isEmpty, snapshot.questions.isEmpty else {
                throw CallError.message("OpenCode is busy or needs input; the existing work was not interrupted")
            }
        } catch { task.state = "proposed"; try save(task); throw error }
        do {
            try await client.prompt(task.sessionID,
                text: task.text + "\n\nImplement only this agreed task and run relevant checks. Do not commit, push or open a PR unless explicitly included above. Report results and blockers.",
                messageID: task.messageID!, agent: "build")
            task.state = "submitted"; try save(task)
        } catch { task.state = "uncertain"; try save(task); throw error }
        return task
    }
    public func reconcile(_ snapshot: Snapshot) throws {
        for var task in currentRecords where task.sessionID == snapshot.sessionID && Self.active.contains(task.state) {
            let accepted = snapshot.messages.contains { $0["info"]["id"].string == task.messageID }
            let last = snapshot.messages.last { $0["info"]["role"].string == "assistant" && $0["info"]["parentID"].string == task.messageID }
            if let last, last["info"]["error"] != .null {
                task.state = last["info"]["error"]["name"].string == "MessageAbortedError" ? "cancelled" : "failed"
            } else if accepted, snapshot.status == "idle", let last, Snapshot.isTerminal(last) { task.state = "finished" }
            else if !accepted { task.state = "uncertain" }
            else if task.state != "cancelling" {
                task.state = !snapshot.permissions.isEmpty || !snapshot.questions.isEmpty ? "waiting" : snapshot.status == "idle" ? "submitted" : "running"
            }
            try save(task)
        }
    }
    public func cancel(_ id: String) async throws {
        var task = try record(id)
        guard Self.active.contains(task.state) else { throw CallError.message("Task is not active") }
        let snapshot = try await client.snapshot(task.sessionID)
        guard snapshot.messages.last(where: { $0["info"]["role"].string == "user" })?["info"]["id"].string == task.messageID else {
            throw CallError.message("Cannot confirm this task still owns the active session")
        }
        task.state = "cancelling"; try save(task)
        _ = try await client.request("/session/\(task.sessionID)/abort", method: "POST")
    }
}
