import XCTest
@testable import CallCore

final class AuthorizationTests: XCTestCase {
    func testFreshDanishAuthorizationIsSingleUse() throws {
        var gate = AuthorizationGate()
        gate.record(id: "old", text: "start building")
        let proposalSequence = gate.sequence
        XCTAssertThrowsError(try gate.consume(.build, after: proposalSequence))
        gate.record(id: "new", text: "Gå i gang med at bygge!")
        try gate.consume(.build, after: proposalSequence)
        XCTAssertThrowsError(try gate.consume(.build, after: proposalSequence))
    }
    func testNegationsQuotesAndVagueAgreementDoNotAuthorize() {
        for phrase in ["okay", "don't start building", "gå ikke i gang med at bygge", "say start building", "start building later", "\"start building\""] {
            var gate = AuthorizationGate()
            gate.record(id: "utterance", text: phrase)
            XCTAssertThrowsError(try gate.consume(.build), phrase)
        }
    }
    func testExpiredAndReplayedTranscriptCannotAuthorize() {
        var gate = AuthorizationGate()
        let date = Date(timeIntervalSince1970: 100)
        gate.record(id: "same", text: "start building", now: date)
        gate.record(id: "same", text: "start building", now: date.addingTimeInterval(61))
        XCTAssertThrowsError(try gate.consume(.build, now: date.addingTimeInterval(61)))
    }
    func testBareStopDoesNotCancelAndAnswerMustMatch() throws {
        var gate = AuthorizationGate()
        gate.record(id: "stop", text: "stop")
        XCTAssertThrowsError(try gate.consume(.cancel))
        let sequence = gate.sequence
        gate.record(id: "answer", text: "Apple")
        XCTAssertThrowsError(try gate.consumeAnswer("Google", after: sequence))
        try gate.consumeAnswer("Apple", after: sequence)
        XCTAssertThrowsError(try gate.consumeAnswer("Apple", after: sequence))
    }
}
