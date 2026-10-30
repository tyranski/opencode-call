import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import CallCore

private actor ServerFixture {
    var submissions = 0
    var messages: JSON = .array([])
    func setMessages(_ value: JSON) { messages = value }
    func handle(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        var status = 200
        let body: JSON
        switch path {
        case "/session/ses_test": body = .object(["title": .string("Login")])
        case "/session/status": body = .object([:])
        case "/session/ses_test/message": body = messages
        case "/permission", "/question": body = .array([])
        case "/session/ses_test/prompt_async":
            submissions += 1
            let prompt = try JSON.decode(request.httpBody!)
            // Simulate server acceptance followed by a failed HTTP response.
            messages = .array([.object(["info": .object(["id": prompt["messageID"], "role": .string("user")]), "parts": .array([])])])
            body = .null; status = 503
        default: body = .null; status = 404
        }
        return (try JSONEncoder().encode(body), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

final class WorkflowTests: XCTestCase {
    @MainActor func testUncertainSubmissionSurvivesRestartWithoutReplay() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = ServerFixture()
        var settings = ConnectionSettings(); settings.serverURL = "https://pc.example.test"
        let client = OpenCodeClient(settings: settings, http: HTTP { request in try await fixture.handle(request) })
        let journal = root.appendingPathComponent("tasks.json")
        let workflow = try NativeWorkflow(client: client, journalURL: journal)
        let task = try workflow.propose(sessionID: "ses_test", text: "Fix login")
        do { _ = try await workflow.authorize(task.id); XCTFail("Expected uncertain response") } catch {}
        XCTAssertEqual(try workflow.record(task.id).state, "uncertain")
        let restarted = try NativeWorkflow(client: client, journalURL: journal)
        do { _ = try await restarted.authorize(task.id); XCTFail("Must not replay") } catch {}
        let submissions = await fixture.submissions
        XCTAssertEqual(submissions, 1)
        try restarted.reconcile(try await client.snapshot("ses_test"))
        XCTAssertEqual(try restarted.record(task.id).state, "submitted")
        let messageID = try XCTUnwrap(restarted.record(task.id).messageID)
        await fixture.setMessages(.array([
            .object(["info": .object(["id": .string(messageID), "role": .string("user")]), "parts": .array([])]),
            .object(["info": .object(["id": .string("msg_done"), "parentID": .string(messageID),
                "role": .string("assistant"), "finish": .string("stop"), "time": .object(["completed": .number(1)])]), "parts": .array([])])
        ]))
        try restarted.reconcile(try await client.snapshot("ses_test"))
        XCTAssertEqual(try restarted.record(task.id).state, "finished")
    }
}
