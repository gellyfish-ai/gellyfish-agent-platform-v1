import SwiftUI

struct PairingView: View {
    @ObservedObject private var pushManager = PushNotificationManager.shared
    @Environment(\.dismiss) private var dismiss

    @State private var pairingCode = ""
    @State private var generatedCode = ""
    @State private var isPairing = false
    @State private var isConfirming = false
    @State private var errorMessage: String?
    @State private var step: PairingStep = .ready

    enum PairingStep {
        case ready
        case generatingKey
        case waitingForCode
        case confirming
        case success
        case failed
    }

    var body: some View {
        NavigationView {
            VStack(spacing: 24) {
                Spacer()

                stepIcon
                stepTitle
                stepDescription

                if step == .waitingForCode {
                    codeEntryField
                }

                if let error = errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                actionButton

                Spacer()
            }
            .padding()
            .navigationTitle("Pair Device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private var stepIcon: some View {
        switch step {
        case .ready:
            Image(systemName: "key.radiowaves.forward")
                .font(.system(size: 60))
                .foregroundStyle(.blue)
        case .generatingKey:
            ProgressView()
                .scaleEffect(2)
        case .waitingForCode:
            Image(systemName: "number.square")
                .font(.system(size: 60))
                .foregroundStyle(.orange)
        case .confirming:
            ProgressView()
                .scaleEffect(2)
        case .success:
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 60))
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 60))
                .foregroundStyle(.red)
        }
    }

    @ViewBuilder
    private var stepTitle: some View {
        switch step {
        case .ready:
            Text("Secure Device Pairing")
                .font(.title2.bold())
        case .generatingKey:
            Text("Generating Key...")
                .font(.title2.bold())
        case .waitingForCode:
            Text("Enter Pairing Code")
                .font(.title2.bold())
        case .confirming:
            Text("Confirming...")
                .font(.title2.bold())
        case .success:
            Text("Device Paired")
                .font(.title2.bold())
        case .failed:
            Text("Pairing Failed")
                .font(.title2.bold())
        }
    }

    @ViewBuilder
    private var stepDescription: some View {
        switch step {
        case .ready:
            Text("This will generate a secure key on your device using the Secure Enclave. Approval actions will require Face ID.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        case .generatingKey:
            Text("Creating cryptographic key pair...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        case .waitingForCode:
            if !generatedCode.isEmpty {
                Text("Your pairing code:")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text(generatedCode)
                    .font(.system(size: 40, weight: .bold, design: .monospaced))
                    .kerning(8)
                    .padding(.vertical, 8)
                Text("Enter this code below to confirm pairing.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        case .confirming:
            Text("Verifying pairing code...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        case .success:
            Text("Your device is now paired. Approvals will be cryptographically signed with Face ID.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        case .failed:
            Text(errorMessage ?? "Something went wrong. Please try again.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private var codeEntryField: some View {
        TextField("000000", text: $pairingCode)
            .keyboardType(.numberPad)
            .font(.system(size: 32, weight: .bold, design: .monospaced))
            .multilineTextAlignment(.center)
            .frame(maxWidth: 200)
            .padding()
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .onChange(of: pairingCode) { _, newValue in
                // Limit to 6 digits
                let filtered = String(newValue.filter(\.isNumber).prefix(6))
                if filtered != newValue { pairingCode = filtered }
            }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch step {
        case .ready:
            Button {
                startPairing()
            } label: {
                Text("Start Pairing")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

        case .waitingForCode:
            Button {
                confirmPairing()
            } label: {
                Text("Confirm")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(pairingCode.count != 6)

        case .success:
            Button {
                dismiss()
            } label: {
                Text("Done")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

        case .failed:
            Button {
                step = .ready
                errorMessage = nil
                pairingCode = ""
            } label: {
                Text("Try Again")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

        default:
            EmptyView()
        }
    }

    private func startPairing() {
        step = .generatingKey
        errorMessage = nil

        Task {
            do {
                let code = try await pushManager.initiatePairing()
                generatedCode = code
                step = .waitingForCode
            } catch {
                errorMessage = error.localizedDescription
                step = .failed
            }
        }
    }

    private func confirmPairing() {
        step = .confirming
        errorMessage = nil

        Task {
            do {
                try await pushManager.confirmPairing(code: pairingCode)
                step = .success
            } catch {
                errorMessage = error.localizedDescription
                step = .failed
            }
        }
    }
}
