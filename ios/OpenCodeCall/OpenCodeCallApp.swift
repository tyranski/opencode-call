import SwiftUI

@main struct OpenCodeCallApp: App {
    @StateObject private var model = VoiceModel()
    var body: some Scene {
        WindowGroup { ContentView(model: model) }
    }
}

struct ContentView: View {
    @ObservedObject var model: VoiceModel
    @State private var showSettings = false
    var body: some View {
        NavigationStack {
            List {
                Section("OpenCode") {
                    Picker("Session", selection: $model.selectedID) {
                        Text("Choose a session").tag("")
                        ForEach(model.sessions) { session in Text(session.title).tag(session.id) }
                    }.disabled(model.active || model.connecting)
                    Button("Load sessions") { Task { await model.loadSessions() } }
                        .disabled(model.active || model.connecting)
                    Text(model.status).font(.footnote).foregroundStyle(.secondary)
                    if !model.errorText.isEmpty { Text(model.errorText).foregroundStyle(.red).textSelection(.enabled) }
                }
                Section("Voice") {
                    if model.connecting { ProgressView("Connecting…") }
                    Button(model.active || model.connecting ? "End voice" : "Start voice") {
                        Task { if model.active || model.connecting { await model.stop() } else { await model.start() } }
                    }.disabled(model.selectedID.isEmpty)
                    if model.active {
                        Button(model.muted ? "Resume conversation" : "Mute microphone") { Task { await model.toggleMute() } }
                        Button("Ask for progress") { Task { await model.askProgress() } }
                    }
                }
                if !model.proposalText.isEmpty {
                    Section("Agreed task") {
                        Text(model.proposalText).textSelection(.enabled)
                        Text("Say ‘start building’ or ‘gå i gang med at bygge’ to authorize this task.").font(.footnote)
                    }
                }
                Section("Conversation") {
                    ForEach(model.transcript) { line in
                        VStack(alignment: .leading) {
                            Text(line.role).font(.caption).foregroundStyle(.secondary)
                            Text(line.text).textSelection(.enabled)
                        }
                    }
                    TextField("Type a reply", text: $model.draft, axis: .vertical).disabled(!model.active)
                    Button("Send") { Task { await model.sendText() } }.disabled(!model.active || model.draft.isEmpty)
                }
                if !model.activity.isEmpty {
                    DisclosureGroup("Latest activity") { Text(model.activity).font(.caption.monospaced()).textSelection(.enabled) }
                }
            }
            .navigationTitle("OpenCode Call")
            .toolbar { Button("Settings", systemImage: "gear") { showSettings = true }.disabled(model.active || model.connecting) }
            .sheet(isPresented: $showSettings) { SettingsView(model: model) }
        }
    }
}

struct SettingsView: View {
    @ObservedObject var model: VoiceModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("Your OpenCode server") {
                    TextField("https://pc.tailnet.ts.net", text: $model.settings.serverURL).keyboardType(.URL)
                    TextField("Project directory on Ubuntu", text: $model.settings.directory)
                    TextField("Username", text: $model.settings.username)
                    SecureField("Server password (if enabled)", text: $model.settings.password)
                    Text("Use an address reachable from the iPhone. localhost means this iPhone, not your PC. Tailscale must be connected for private remote access.").font(.footnote)
                }
                Section("Your ElevenLabs account") {
                    SecureField("API key", text: $model.settings.elevenLabsKey)
                    TextField("Agent ID", text: $model.settings.agentID)
                    Text("Create your own account and agent. Use the existing project's client-tool configuration. The key needs Agents write access (convai_write). Credentials are saved in this device's Keychain.").font(.footnote)
                }
                Section("Device testing") {
                    Text("Use headphones. Background audio is enabled for experiments; locked-screen recovery, wake phrases, and music controls are not yet verified. Ending voice leaves PC work running.").font(.footnote)
                }
                Button("Save settings") { model.saveSettings(); if model.errorText.isEmpty { dismiss() } }
                if !model.errorText.isEmpty { Text(model.errorText).foregroundStyle(.red) }
            }
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .navigationTitle("Connections")
            .toolbar { Button("Close") { dismiss() } }
        }
    }
}
