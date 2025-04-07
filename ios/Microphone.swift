import AVFoundation
import ExpoModulesCore
import ffmpegkit


class Microphone {
    weak var delegate: MicrophoneDataDelegate?
    
    private var audioEngine: AVAudioEngine!
    private var audioConverter: AVAudioConverter!
    private var inputNode: AVAudioInputNode!
    
    public private(set) var isVoiceProcessingEnabled: Bool = false
    
    
    internal var lastEmissionTime: Date?
    internal var lastEmittedSize: Int64 = 0
    private var emissionInterval: TimeInterval = 1.0 // Default to 1 second
    private var totalDataSize: Int64 = 0
    internal var recordingSettings: RecordingSettings?
    
    internal var mimeType: String = "audio/wav"
    private var lastBufferTime: AVAudioTime?
    private var accumulatedData = Data()
    
    private var startTime: Date?
    private var pauseStartTime: Date?
    
    // FFmpeg pipe related properties
    private var ffmpegPipe: String?
    private var ffmpegSession: FFmpegSession?
    private var ffmpegPipeFileHandle: FileHandle?
    private var webmFileUri: String?
    

    private var inittedAudioSession = false
    private var isRecording: Bool = false
    private var isSilent: Bool = false
    
    init() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }
    
    /// Handles audio route changes (e.g. headphones connected/disconnected)
    /// - Parameter notification: The notification object containing route change information
    @objc private func handleRouteChange(notification: Notification) {
        guard let info = notification.userInfo,
              let reasonValue = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }
        
        Logger.debug("[Microphone] Route is changed \(reason)")

        switch reason {
        case .newDeviceAvailable, .oldDeviceUnavailable:
            if isRecording {
                stopRecording(resolver: nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    guard let self = self else { return }
                    
                    _ = startRecording(settings: self.recordingSettings!, intervalMilliseconds: 100)
                }
            }
        case .categoryChange:
            Logger.debug("[Microphone] Audio Session category changed")
        default:
            break
        }
    }
    
    func toggleSilence() {
        Logger.debug("[Microphone] toggleSilence")
        self.isSilent = !self.isSilent
    }
    
    /// Creates and starts an FFmpeg session to encode raw PCM data to WebM
    /// - Parameter settings: Recording settings for the audio
    /// - Returns: The URI of the WebM file, or nil if setup failed
    private func setupFFmpegPipe(settings: RecordingSettings) -> String? {
        // Create a unique filename for the WebM output
        let fileManager = FileManager.default
        let documentsDirectory = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        let webmFilename = UUID().uuidString + ".webm"
        let webmFileURL = documentsDirectory.appendingPathComponent(webmFilename)
        
        // Register a new FFmpeg pipe
        guard let pipe = FFmpegKitConfig.registerNewFFmpegPipe() else {
            Logger.debug("[Microphone] Failed to create FFmpeg pipe")
            return nil
        }
        
        self.ffmpegPipe = pipe
        
        // Build the FFmpeg command
        // For WebM format with Opus codec, commonly used for web audio
        let sampleRate = Int(settings.sampleRate)
        let channels = settings.numberOfChannels
        let bitDepth = settings.bitDepth
        
        let format: String
        switch bitDepth {
        case 8:
            format = "u8"
        case 16:
            format = "s16le"
        case 32:
            format = "s32le"
        default:
            format = "s16le" // Default to 16-bit
        }
        
        // Construct FFmpeg command to convert raw PCM to WebM with Opus codec
        let ffmpegCommand = "-f \(format) -ar \(sampleRate) -ac \(channels) -i \(pipe) -c:a libopus -b:a 128k \"\(webmFileURL.path)\""
        
        Logger.debug("[Microphone] Starting FFmpeg with command: \(ffmpegCommand)")
        
        // Execute FFmpeg command asynchronously
        ffmpegSession = FFmpegKit.executeAsync(ffmpegCommand) { session in
            if let returnCode = session?.getReturnCode(), returnCode.isValueSuccess() {
                Logger.debug("[Microphone] FFmpeg process completed successfully")
            } else {
                Logger.debug("[Microphone] FFmpeg process failed: \(session?.getFailStackTrace() ?? "Unknown error")")
            }
        } withLogCallback: { log in
            Logger.debug("[Microphone] FFmpeg log: \(log?.getMessage() ?? "")")
        } withStatisticsCallback: { statistics in
            // Handle statistics if needed
        }
        
        // Open the pipe for writing
        self.ffmpegPipeFileHandle = FileHandle(forWritingAtPath: pipe)
        if self.ffmpegPipeFileHandle == nil {
            Logger.debug("[Microphone] Failed to open pipe for writing")
            return nil
        }
        
        // Return the WebM file URI
        webmFileUri = webmFileURL.absoluteString
        return webmFileURL.absoluteString
    }
    
    /// Closes the FFmpeg pipe and releases resources
    private func closeFFmpegPipe() {
        if let pipe = ffmpegPipe {
            // Close the file handle first
            ffmpegPipeFileHandle?.closeFile()
            ffmpegPipeFileHandle = nil
            
            // Close the pipe
            FFmpegKitConfig.closeFFmpegPipe(pipe)
            ffmpegPipe = nil
            Logger.debug("[Microphone] FFmpeg pipe closed")
        }
        
        // Cancel FFmpeg session if it's still running
        if let session = ffmpegSession, session.getState() != .completed && session.getState() != .failed {
            FFmpegKit.cancel(session.getId())
            Logger.debug("[Microphone] FFmpeg session cancelled")
        }
        ffmpegSession = nil
    }
    
    func startRecording(settings: RecordingSettings, intervalMilliseconds: Int) -> StartRecordingResult? {
        guard !isRecording else {
            Logger.debug("Debug: Recording is already in progress.")
            return StartRecordingResult(error: "Recording is already in progress.")
        }
        
        if self.audioEngine == nil {
            self.audioEngine = AVAudioEngine()
        }
        
        if self.audioEngine != nil && audioEngine.isRunning  {
            Logger.debug("Debug: Audio engine already running.")
            audioEngine.stop()
        }
       
        var newSettings = settings  // Make settings mutable
        
        // Determine the commonFormat based on bitDepth
        let commonFormat: AVAudioCommonFormat = AudioUtils.getCommonFormat(depth: newSettings.bitDepth)
        
        emissionInterval = max(100.0, Double(intervalMilliseconds)) / 1000.0
        lastEmissionTime = Date()
        accumulatedData.removeAll()
        totalDataSize = 0
        
        let session = AVAudioSession.sharedInstance()
        Logger.debug("Debug: Configuring audio session with sample rate: \(settings.sampleRate) Hz")
        
        // Check if the input node supports the desired format
        let hardwareFormat = audioEngine.inputNode.inputFormat(forBus: 0)
        if hardwareFormat.sampleRate != newSettings.sampleRate {
            Logger.debug("Debug: Preferred sample rate not supported. Falling back to hardware sample rate \(session.sampleRate).")
            newSettings.sampleRate = session.sampleRate
        }
        
        let actualSampleRate = session.sampleRate
        if actualSampleRate != newSettings.sampleRate {
            Logger.debug("Debug: Preferred sample rate not set. Falling back to hardware sample rate: \(actualSampleRate) Hz")
            newSettings.sampleRate = actualSampleRate
        }
        Logger.debug("Debug: Audio session is successfully configured. Actual sample rate is \(actualSampleRate) Hz")
        
        recordingSettings = newSettings  // Update the class property with the new settings
        
        // Set up FFmpeg pipe for WebM recording
        let webmUri = setupFFmpegPipe(settings: newSettings)
        
        // Correct the format to use 16-bit integer (PCM)
        guard let audioFormat = AVAudioFormat(commonFormat: commonFormat, sampleRate: newSettings.sampleRate, channels: UInt32(newSettings.numberOfChannels), interleaved: true) else {
            Logger.debug("Error: Failed to create audio format with the specified bit depth.")
            return StartRecordingResult(error: "Error: Failed to create audio format with the specified bit depth.")
        }
        
        audioEngine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: audioFormat) { [weak self] (buffer, time) in
            guard let self = self else {
                Logger.debug("Error: File URL or self is nil during buffer processing.")
                return
            }
            
            self.processAudioBuffer(buffer)
            self.lastBufferTime = time
        }
        
        do {
            startTime = Date()
            try audioEngine.start()
            isRecording = true
            Logger.debug("Debug: Recording started successfully.")
            return StartRecordingResult(
                fileUri: "",
                webmFileUri: webmUri,
                mimeType: mimeType,
                channels: settings.numberOfChannels,
                bitDepth: settings.bitDepth,
                sampleRate: settings.sampleRate
            )
        } catch {
            Logger.debug("Error: Could not start the audio engine: \(error.localizedDescription)")
            isRecording = false
            return StartRecordingResult(error: "Error: Could not start the audio engine: \(error.localizedDescription)")
        }
    }
    
    public func stopRecording(resolver promise: Promise?) {
        guard self.isRecording else {
            if let promiseResolver = promise {
                promiseResolver.resolve(nil)
            }
            return
        }
        
        // Close FFmpeg pipe before stopping recording
        closeFFmpegPipe()
        
        self.isRecording = false
        self.isVoiceProcessingEnabled = false
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        
        if let promiseResolver = promise {
            promiseResolver.resolve(nil)
        }
    }
    
    /// Processes the audio buffer and writes data to the file. Also handles audio processing if enabled.
    /// - Parameters:
    ///   - buffer: The audio buffer to process.
    ///   - fileURL: The URL of the file to write the data to.
    private func processAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        let targetSampleRate = recordingSettings?.desiredSampleRate ?? buffer.format.sampleRate
        let finalBuffer: AVAudioPCMBuffer
               
        
        if buffer.format.sampleRate != targetSampleRate {
            // Resample the audio buffer if the target sample rate is different from the input sample rate
            if let resampledBuffer = AudioUtils.resampleAudioBuffer(buffer, from: buffer.format.sampleRate, to: targetSampleRate) {
                finalBuffer = resampledBuffer
            } else {
                if let convertedBuffer = AudioUtils.tryConvertToFormat(
                    inputBuffer: buffer,
                    desiredSampleRate: targetSampleRate,
                    desiredChannel: 1,
                    bitDepth: recordingSettings?.bitDepth ?? 16
                ) {
                    finalBuffer = convertedBuffer
                } else {
                    Logger.debug("Failed to convert to desired format.")
                    finalBuffer = buffer
                }
            }
        } else {
            // Use the original buffer if the sample rates are the same
            finalBuffer = buffer
        }
        
        let powerLevel: Float = AudioUtils.calculatePowerLevel(from: finalBuffer)
        
        let audioData = finalBuffer.audioBufferList.pointee.mBuffers
        guard let bufferData = audioData.mData else {
            Logger.debug("Buffer data is nil.")
            return
        }
        
        //let data = Data(bytes: bufferData, count: Int(audioData.mDataByteSize))
        let data = isSilent
                    ? Data(repeating: 0, count:
                            Int(finalBuffer.frameCapacity) * Int(finalBuffer.format.streamDescription.pointee.mBytesPerFrame))
                    : Data(bytes: bufferData, count: Int(audioData.mDataByteSize))
        
        // Write data to FFmpeg pipe if available
        if let fileHandle = ffmpegPipeFileHandle {
            fileHandle.write(data)
        }
        
        // Accumulate new data
        accumulatedData.append(data)
        totalDataSize += Int64(data.count)
        
        let currentTime = Date()
        if let lastEmissionTime = lastEmissionTime, currentTime.timeIntervalSince(lastEmissionTime) >= emissionInterval {
            if let startTime = startTime {
                _ = currentTime.timeIntervalSince(startTime)
                // Copy accumulated data for processing
                let dataToProcess = accumulatedData
                
                // Emit the processed audio data
                self.delegate?.onMicrophoneData(dataToProcess, powerLevel)
                
                self.lastEmissionTime = currentTime // Update last emission time
                self.lastEmittedSize = totalDataSize
                accumulatedData.removeAll() // Reset accumulated data after emission
            }
        }
    }
}
