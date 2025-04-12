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
    private var emissionInterval: TimeInterval = 1.0 // Default to 1 second
    private var totalDataSize: Int64 = 0
    internal var recordingSettings: RecordingSettings?
    
    internal var mimeType: String = "audio/wav"
    private var lastBufferTime: AVAudioTime?
    private var accumulatedData = Data()
    
    private var startTime: Date?
    
    // FFmpeg pipe related properties
    private var ffmpegPipe: String?
    private var ffmpegPipeFileHandle: FileHandle?

    private var inittedAudioSession = false
    private var isRecording: Bool = false
    
    private var audioChunkCounter: Int = 0
    private var streamUuid: String = ""
    private var mp4File: URL?
    private var lastAudioChunkSize: Int64 = 0
    private var fileMonitor: DispatchSourceFileSystemObject?
    private var isPipeClosed: Bool = false 
    
    private var sentChunkIndices = Set<Int>()
    
    private var isFFmpegCompleted: Bool = false
    
    private var fileChangeDebounceTimer: Timer?
    private var chunkCreationDebounceTimer: Timer?
    
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
                    
                    _ = startRecording(settings: self.recordingSettings!, intervalMilliseconds: Int(emissionInterval))
                }
            }
        case .categoryChange:
            Logger.debug("[Microphone] Audio Session category changed")
        default:
            break
        }
    }
    
    /// Creates and starts an FFmpeg session to encode raw PCM data to MP4
    /// - Parameter settings: Recording settings for the audio
    /// - Returns: The URI of the MP4 file, or nil if setup failed
    private func setupFFmpegPipe(settings: RecordingSettings) -> String? {
        let fileManager = FileManager.default
        let documentsDirectory = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        
        streamUuid = UUID().uuidString
        let mp4FileName = "audio_\(streamUuid).mp4"
        let mp4FileUrl = documentsDirectory.appendingPathComponent(mp4FileName)
        mp4File = mp4FileUrl
        
        // reset all states
        sentChunkIndices.removeAll()
        audioChunkCounter = 0
        lastAudioChunkSize = 0
        isPipeClosed = false
        isFFmpegCompleted = false
        
        // create an empty file so we can ensure the file is created before monitoring
        fileManager.createFile(atPath: mp4FileUrl.path, contents: nil)
        
        guard let pipe = FFmpegKitConfig.registerNewFFmpegPipe() else {
            Logger.debug("[Microphone] Failed to create FFmpeg pipe")
            return nil
        }
        
        self.ffmpegPipe = pipe
        
        // Build the FFmpeg command
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
                
        let ffmpegCommand = "-f \(format) -ar \(sampleRate) -ac \(channels) -i \(pipe) -c:a aac -b:a 192k -flush_packets 1 -max_delay 0 -fflags nobuffer -flags low_delay -f mp4 -movflags frag_keyframe+empty_moov+faststart -frag_duration 1000000 -y \"\(mp4FileUrl.path)\""
        
        // setup ffmpeg session and handle completion callback
        FFmpegKit.executeAsync(ffmpegCommand) { [weak self] session in
            guard let self = self else { return }

            Logger.debug("[Microphone] FFmpeg session completed")
            self.isFFmpegCompleted = true
            self.debouncedHandleFileChange()
        } withLogCallback: { log in
        } withStatisticsCallback: { statistics in
        }
        
        self.ffmpegPipeFileHandle = FileHandle(forWritingAtPath: pipe)
        if self.ffmpegPipeFileHandle == nil {
            Logger.debug("[Microphone] Failed to open pipe for writing")
            return nil
        }
        
        setupFileMonitoring(for: mp4FileUrl)
        
        return mp4FileUrl.absoluteString
    }
    
    private func setupFileMonitoring(for fileURL: URL) {
        fileMonitor?.cancel()
        fileMonitor = nil
        
        // open the file to get the file descriptor
        guard let fileHandle = try? FileHandle(forReadingFrom: fileURL),
              let fileDescriptor = try? fileHandle.fileDescriptor else {
            Logger.debug("[Microphone] Failed to get file descriptor for monitoring")
            return
        }
        
        let monitor = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fileDescriptor,
            eventMask: .write,
            queue: DispatchQueue.global(qos: .background)
        )
        
        monitor.setEventHandler { [weak self] in
            guard let self = self else { return }
            self.debouncedHandleFileChange()
        }
        
        monitor.setCancelHandler {
            try? fileHandle.close()
        }
        
        monitor.resume()
        fileMonitor = monitor
        Logger.debug("[Microphone] File monitoring started for \(fileURL.lastPathComponent)")
    }
    
    private func debouncedHandleFileChange() {
        Logger.debug("[Microphone] Debounced handle file change")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            self.fileChangeDebounceTimer?.invalidate()
            
            self.fileChangeDebounceTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
                guard let self = self else { return }
                
                self.createAndEmitAudioChunk()
            }
        }
    }
    
    private func closeFFmpegPipe() {
        isPipeClosed = true
        Logger.debug("[Microphone] Marking FFmpeg pipe as closed")
        
        // Ensure all data is written
        if let fileHandle = ffmpegPipeFileHandle {
            fileHandle.synchronizeFile()
            fileHandle.closeFile()
            ffmpegPipeFileHandle = nil
            Logger.debug("[Microphone] FFmpeg pipe file handle closed")
        }
        
        if let pipe = ffmpegPipe {
            FFmpegKitConfig.closeFFmpegPipe(pipe)
            ffmpegPipe = nil
            Logger.debug("[Microphone] FFmpeg pipe closed")
        }
    }
    
    private func createAndEmitAudioChunk() {
        guard let mp4FileURL = self.mp4File, FileManager.default.fileExists(atPath: mp4FileURL.path) else {
            Logger.debug("[Microphone] MP4 file does not exist, skipping chunk creation")
            return
        }

        Logger.debug("[Microphone] Creating and emitting audio chunk, isFFmpegCompleted: \(self.isFFmpegCompleted)")
        
        do {
            let fileAttributes = try FileManager.default.attributesOfItem(atPath: mp4FileURL.path)
            guard let fileSize = fileAttributes[.size] as? Int64 else {
                Logger.debug("[Microphone] Unable to get file size")
                return
            }
            
            // Skip if the file size is not increased and it's not the last chunk
            if fileSize <= self.lastAudioChunkSize && !self.isFFmpegCompleted {
                Logger.debug("[Microphone] File size not increased (current: \(fileSize), last: \(self.lastAudioChunkSize)), skipping")
                return
            }
            
            let documentsDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            // let documentsDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
            let chunkFileName = "chunk_\(self.streamUuid)_\(self.audioChunkCounter).mp4"
            let chunkFile = documentsDirectory.appendingPathComponent(chunkFileName)
            
            let fileHandle = try FileHandle(forReadingFrom: mp4FileURL)
            
            let startOffset = self.lastAudioChunkSize
            let length = fileSize - startOffset
            
            try fileHandle.seek(toOffset: UInt64(startOffset))
            let chunkData = fileHandle.readDataToEndOfFile()
            try fileHandle.close()

            try chunkData.write(to: chunkFile)
            self.lastAudioChunkSize = fileSize
            self.emitChunkUpdate(chunkFileUri: chunkFile.absoluteString, chunkIndex: self.audioChunkCounter, isLastChunk: self.isFFmpegCompleted, length: length)
            self.sentChunkIndices.insert(self.audioChunkCounter)
            self.audioChunkCounter += 1
            
            Logger.debug("[Microphone] Created and emitted chunk \(self.audioChunkCounter-1) with size \(chunkData.count) bytes, isLastChunk: \(self.isFFmpegCompleted), length: \(length)")
            
            if self.isFFmpegCompleted {
                self.fileMonitor?.cancel()
                self.fileMonitor = nil
                Logger.debug("[Microphone] File monitoring stopped after final chunk")
                
            }
        } catch {
            Logger.debug("[Microphone] Error creating audio chunk: \(error.localizedDescription)")
            
            if self.isFFmpegCompleted {
                self.fileMonitor?.cancel()
                self.fileMonitor = nil
                Logger.debug("[Microphone] File monitoring stopped after error in final chunk")
            }
        }
    }
    
    private func emitChunkUpdate(chunkFileUri: String, chunkIndex: Int, isLastChunk: Bool, length: Int64) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            Logger.debug("[Microphone] Emitting chunk update for chunk \(chunkIndex), isLastChunk: \(isLastChunk), processedSize: \(self.lastAudioChunkSize), length: \(length)")
            
            self.delegate?.onAudioChunkUpdate(
                chunkFileUri: chunkFileUri,
                chunkIndex: chunkIndex,
                streamUuid: self.streamUuid,
                isLastChunk: isLastChunk,
                length: length
            )
        }
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
        // Add a fallback for the simulator
        #if TARGET_OS_SIMULATOR
            if newSettings.sampleRate > 44100.0 {
                Logger.debug("Debug: Sample rate too high for simulator, falling back to 44100 Hz")
                newSettings.sampleRate = 44100.0
            }
        #endif
        Logger.debug("Debug: Audio session is successfully configured. Actual sample rate is \(actualSampleRate) Hz")
        
        recordingSettings = newSettings  // Update the class property with the new settings
        
        isPipeClosed = false
        isFFmpegCompleted = false
        
        let mp4Uri = setupFFmpegPipe(settings: newSettings)
        
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
                mp4FileUri: mp4Uri,
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
    
    // @TODO return the final file size
    public func stopRecording(resolver promise: Promise?) {
        guard self.isRecording else {
            if let promiseResolver = promise {
                promiseResolver.resolve(nil)
            }
            return
        }
        
        self.isRecording = false
        self.isVoiceProcessingEnabled = false
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)


        // write the final accumulated data to the ffmpeg pipe
        if !accumulatedData.isEmpty && ffmpegPipeFileHandle != nil {
          // @TODO remove
            Logger.debug("[Microphone] Writing final accumulated data (\(accumulatedData.count) bytes) to FFmpeg pipe")
            ffmpegPipeFileHandle?.write(accumulatedData)
            accumulatedData.removeAll()
        }
        
        closeFFmpegPipe()
        
        if let promiseResolver = promise {
            promiseResolver.resolve(nil)
        }
    }
    
    /// Processes the audio buffer and writes data to the FFmpeg pipe.
    /// - Parameters:
    ///   - buffer: The audio buffer to process.
    private func processAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        let targetSampleRate = recordingSettings?.desiredSampleRate ?? buffer.format.sampleRate
        let finalBuffer: AVAudioPCMBuffer

        if buffer.format.sampleRate != targetSampleRate {
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
                    Logger.debug("[Microphone] Failed to convert to desired format.")
                    finalBuffer = buffer
                }
            }
        } else {
            finalBuffer = buffer
        }
        
        let powerLevel: Float = AudioUtils.calculatePowerLevel(from: finalBuffer)
        
        let audioData = finalBuffer.audioBufferList.pointee.mBuffers
        guard let bufferData = audioData.mData else {
            Logger.debug("[Microphone] Buffer data is nil.")
            return
        }
        
        let data = Data(bytes: bufferData, count: Int(audioData.mDataByteSize))
        
        accumulatedData.append(data)
        totalDataSize += Int64(data.count)
        
        let currentTime = Date()
        let intervalElapsed = lastEmissionTime == nil || currentTime.timeIntervalSince(lastEmissionTime!) >= emissionInterval
        
        if intervalElapsed || !isRecording {
            if let startTime = startTime {
                let dataToProcess = accumulatedData
                
                // self.delegate?.onMicrophoneData(dataToProcess, powerLevel)
                
                if let fileHandle = ffmpegPipeFileHandle, !dataToProcess.isEmpty {
                    fileHandle.write(dataToProcess)
                }
                
                self.lastEmissionTime = currentTime
                accumulatedData.removeAll()
            }
        }
    }
}
