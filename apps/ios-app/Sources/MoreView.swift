import SwiftUI

struct MoreView: View {
    @ObservedObject private var pushManager = PushNotificationManager.shared
    @AppStorage("serverURL") private var serverURL = "http://10.0.0.1:3000"
    @AppStorage("voice-language") private var voiceLanguage = "en"
    @AppStorage("silence-threshold") private var silenceThreshold = "2"
    @AppStorage("speech-speed") private var speechSpeed = "normal"
    @AppStorage("auto-listen") private var autoListen = true
    @State private var editURL = ""
    @State private var isEditing = false
    @State private var showPairing = false

    private let languages = [
        ("en", "English"),
        ("es", "Spanish"),
        ("ca", "Catalan"),
        ("ja", "Japanese"),
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    LabeledContent("URL", value: serverURL)
                    Button("Change Server URL") {
                        editURL = serverURL
                        isEditing = true
                    }
                }

                Section("Voice") {
                    Picker("Language", selection: $voiceLanguage) {
                        ForEach(languages, id: \.0) { code, name in
                            Text(name).tag(code)
                        }
                    }

                    Picker("Silence Threshold", selection: $silenceThreshold) {
                        Text("1 second").tag("1")
                        Text("2 seconds").tag("2")
                        Text("3 seconds").tag("3")
                    }

                    Picker("Speech Speed", selection: $speechSpeed) {
                        Text("Slow").tag("slow")
                        Text("Normal").tag("normal")
                        Text("Fast").tag("fast")
                    }

                    Toggle("Auto-listen after response", isOn: $autoListen)
                }

                Section("Push Notifications") {
                    if pushManager.isRegistered {
                        LabeledContent("Status", value: pushManager.isPaired ? "Paired" : "Registered")
                        if let token = pushManager.deviceToken {
                            LabeledContent("Device Token") {
                                Text(String(token.prefix(16)) + "...")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        if pushManager.isPaired {
                            LabeledContent("Security") {
                                Label("Secure Enclave", systemImage: "lock.shield.fill")
                                    .font(.caption)
                                    .foregroundStyle(.green)
                            }
                            Button("Unpair Device") {
                                Task { await pushManager.unpairDevice() }
                            }
                        } else {
                            Button("Pair Device (Secure Enclave)") {
                                showPairing = true
                            }
                        }
                        Button("Unregister Device", role: .destructive) {
                            Task { await pushManager.unregisterDevice() }
                        }
                    } else {
                        LabeledContent("Status", value: "Not registered")
                        Button("Enable Push Notifications") {
                            pushManager.requestPermissionAndRegister()
                        }
                    }
                }

                Section("Diagnostics") {
                    NavigationLink {
                        DiagnosticsView()
                    } label: {
                        Label("Signing Attempts", systemImage: "signature")
                    }
                }

                Section("About") {
                    LabeledContent("App", value: "Gellyfish")
                    LabeledContent("Version", value: "1.0")
                }
            }
            .navigationTitle("More")
            .sheet(isPresented: $isEditing) {
                NavigationView {
                    Form {
                        Section("Server Address") {
                            TextField("URL", text: $editURL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                        }
                    }
                    .navigationTitle("Server URL")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { isEditing = false }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Save") {
                                serverURL = editURL
                                isEditing = false
                            }
                        }
                    }
                }
            }
            .sheet(isPresented: $showPairing) {
                PairingView()
            }
        }
    }
}
