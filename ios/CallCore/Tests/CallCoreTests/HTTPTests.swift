import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import CallCore

final class HTTPTests: XCTestCase {
    func testProjectPathAndBasicAuthAreEncoded() async throws {
        var settings = ConnectionSettings()
        settings.serverURL = "https://pc.example.test"
        settings.directory = "/repo with spaces"
        settings.password = "test-password"
        let client = OpenCodeClient(settings: settings, http: HTTP { request in
            XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "/repo with spaces")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Basic " + Data("opencode:test-password".utf8).base64EncodedString())
            return (Data("{\"healthy\":true}".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        let health = try await client.health()
        XCTAssertEqual(health["healthy"], .bool(true))
    }
    func testTokenMissingPermissionHasActionableError() async throws {
        var settings = ConnectionSettings(); settings.elevenLabsKey = "private-key"; settings.agentID = "agent_test"
        do {
            _ = try await ElevenLabsToken.fetch(settings: settings, http: HTTP { request in
                XCTAssertEqual(request.value(forHTTPHeaderField: "xi-api-key"), "private-key")
                return (Data("{\"detail\":{\"status\":\"missing_permissions\",\"message\":\"private-key\"}}".utf8),
                    HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!)
            })
            XCTFail("Expected rejection")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("convai_write"))
            XCTAssertFalse(error.localizedDescription.contains("private-key"))
        }
    }
    func testToolCallFinishIsNotTerminal() throws {
        let message = try JSON.decode(Data("{\"info\":{\"role\":\"assistant\",\"finish\":\"tool-calls\",\"time\":{\"completed\":1}},\"parts\":[]}".utf8))
        XCTAssertFalse(Snapshot.isTerminal(message))
    }
}
