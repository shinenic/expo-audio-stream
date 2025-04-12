import Foundation
import AVFoundation
import ExpoModulesCore

let audioChunkUpdateEvent: String = "AudioChunkUpdate"

public class ExpoPlayAudioStreamModule: Module, MicrophoneDataDelegate {
    private var _microphone: Microphone?
    
    private var microphone: Microphone {
        if _microphone == nil {
            _microphone = Microphone()
            _microphone?.delegate = self
        } else {
            if _microphone?.delegate == nil {
                _microphone?.delegate = self
            }
        }
        return _microphone!
    }
    
    private var isAudioSessionInitialized: Bool = false

    public func definition() -> ModuleDefinition {
        Name("ExpoPlayAudioStream")
        
        // Defines event names that the module can send to JavaScript.
        Events([audioChunkUpdateEvent])
        
        Function("destroy") {
            // Now we can properly reset all instances
            self._microphone = nil
            self.isAudioSessionInitialized = false
        }
        
        /// Prompts the user to select the microphone mode.
        Function("promptMicrophoneModes") {
            promptForMicrophoneModes()
        }
        
        AsyncFunction("startMicrophone") { (options: [String: Any], promise: Promise) in
            // Create recording settings
            // Extract settings from provided options, using default values if necessary
            let sampleRate = options["sampleRate"] as? Double ?? 16000.0 // it fails if not 48000, why?
            let numberOfChannels = options["channelConfig"] as? Int ?? 1 // Mono channel configuration
            let bitDepth = options["audioFormat"] as? Int ?? 16 // 16bits
            let interval = options["interval"] as? Int ?? 1000
            
            let settings = RecordingSettings(
                sampleRate: sampleRate,
                desiredSampleRate: sampleRate,
                numberOfChannels: numberOfChannels,
                bitDepth: bitDepth,
                maxRecentDataDuration: nil,
                pointsPerSecond: nil
            )
            
            if !isAudioSessionInitialized {
                do {
                    try ensureAudioSessionInitialized(settings: settings)
                } catch {
                    promise.reject("ERROR", "Failed to init audio session \(error.localizedDescription)")
                    return
                }
            }            
            
            if self.microphone.delegate == nil {
                Logger.debug("[ExpoPlayAudioStreamModule] WARNING: Microphone delegate is nil, assigning now")
                self.microphone.delegate = self
            }
            
            if let result = self.microphone.startRecording(settings: settings, intervalMilliseconds: interval) {
                if let resError = result.error {
                    promise.reject("ERROR", resError)
                } else {
                    let resultDict: [String: Any] = [
                        "fileUri": result.fileUri ?? "",
                        "mp4FileUri": result.mp4FileUri ?? "",
                        "channels": result.channels ?? 1,
                        "bitDepth": result.bitDepth ?? 16,
                        "sampleRate": result.sampleRate ?? 48000,
                        "mimeType": result.mimeType ?? "",
                    ]
                    promise.resolve(resultDict)
                }
            } else {
                promise.reject("ERROR", "Failed to start recording.")
            }
        }
        
        /// Stops the microphone recording and releases associated resources
        /// - Parameter promise: A promise to resolve when microphone recording is stopped
        /// - Note: This method stops the active recording session, processes any remaining audio data,
        ///         and releases hardware resources. It should be called when the app no longer needs
        ///         microphone access to conserve battery and system resources.
        AsyncFunction("stopMicrophone") { (promise: Promise) in
            microphone.stopRecording(resolver: promise)
        }
    }
    
    private func ensureAudioSessionInitialized(settings recordingSettings: RecordingSettings? = nil) throws {
        if self.isAudioSessionInitialized { return }

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            .playAndRecord, mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
        if let settings = recordingSettings {
            try audioSession.setPreferredSampleRate(settings.sampleRate)
            try audioSession.setPreferredIOBufferDuration(1024 / settings.sampleRate)
        }
        try audioSession.setActive(true)
        isAudioSessionInitialized = true
    }
    
    // used for voice isolation, experimental
    private func promptForMicrophoneModes() {
        guard #available(iOS 15.0, *) else {
            return
        }
        
        if AVCaptureDevice.preferredMicrophoneMode == .voiceIsolation {
            return
        }
        
        AVCaptureDevice.showSystemUserInterface(.microphoneModes)
    }
    
    func onAudioChunkUpdate(chunkFileUri: String, chunkIndex: Int, streamUuid: String, isLastChunk: Bool, length: Int64) {
        let eventBody: [String: Any] = [
            "chunkFileUri": chunkFileUri,
            "chunkIndex": chunkIndex,
            "streamUuid": streamUuid,
            "isLastChunk": isLastChunk,
            "length": length
        ]
        
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.sendEvent(audioChunkUpdateEvent, eventBody)
        }
    }
}
