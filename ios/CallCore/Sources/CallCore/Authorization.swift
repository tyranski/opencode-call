import Foundation

public struct AuthorizationGate {
    public enum Command: String {
        case build, cancel, approve, reject
        var phrases: Set<String> {
            switch self {
            case .build: return ["start building", "start the build", "implement that", "gå i gang med at bygge", "gå i gang med det", "begynd at bygge"]
            case .cancel: return ["stop building", "cancel the build", "stop med at bygge", "annuller byggeriet"]
            case .approve: return ["approve once", "godkend én gang", "godkend en gang"]
            case .reject: return ["reject permission", "afvis tilladelsen"]
            }
        }
    }
    private struct Utterance { let text: String; let sequence: Int; let date: Date; var consumed = false }
    public private(set) var sequence = 0
    private var seen: Set<String> = []
    private var latest: Utterance?
    public init() {}

    public mutating func record(id: String, text: String, now: Date = Date()) {
        guard seen.insert(id).inserted else { return }
        sequence += 1
        latest = Utterance(text: text, sequence: sequence, date: now)
    }

    public mutating func consume(_ command: Command, after: Int = -1, now: Date = Date()) throws {
        let value = try fresh(after: after, now: now)
        let normalized = value.text.precomposedStringWithCompatibilityMapping.lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: ".!?"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard command.phrases.contains(normalized) else {
            throw CallError.message("Ask for a fresh explicit \(command.rawValue) instruction; this transcript does not authorize it.")
        }
        latest?.consumed = true
    }

    public mutating func consumeAnswer(_ answer: String, after: Int, now: Date = Date()) throws {
        let value = try fresh(after: after, now: now)
        guard value.text == answer else { throw CallError.message("Answer must exactly match the new user transcript") }
        latest?.consumed = true
    }

    private func fresh(after: Int, now: Date) throws -> Utterance {
        guard let value = latest, !value.consumed, value.sequence > after,
              (0...60).contains(now.timeIntervalSince(value.date)) else {
            throw CallError.message("A new explicit user instruction is required; older or already-used instructions cannot authorize work.")
        }
        return value
    }
}
