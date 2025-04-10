import AVFoundation
import ExpoModulesCore
import ffmpegkit


// 移除這個擴展，因為我們已經在協議中添加了該方法
// extension MicrophoneDataDelegate {
//     func onAudioChunkUpdate(chunkFileUri: String, chunkIndex: Int, streamUuid: String) {}
// }

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
    
    // 音頻塊計數和管理
    private var audioChunkCounter: Int = 0
    private var streamUuid: String = ""
    private var webmFile: URL?
    private var lastAudioChunkTime: Date? = nil
    private var lastAudioChunkUri: String? = nil
    
    // 添加一個映射來跟踪哪些塊已經發送過
    private var sentChunkIndices = Set<Int>()
    
    // 添加屬性來跟踪最終塊
    private var finalChunkFileUri: String? = nil
    private var finalChunkIndex: Int = 0
    
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
        
        // 產生唯一的 streamUuid
        streamUuid = UUID().uuidString
        let webmFilename = "audio_\(streamUuid).mp4"
        let webmFileURL = documentsDirectory.appendingPathComponent(webmFilename)
        webmFile = webmFileURL
        
        // 重置音頻塊計數器
        audioChunkCounter = 0
        lastAudioChunkTime = nil
        lastAudioChunkUri = nil
        
        // 重置最終塊信息
        finalChunkFileUri = nil
        finalChunkIndex = 0
        
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
        
        let ffmpegCommand = "-f \(format) -ar \(sampleRate) -ac \(channels) -i \(pipe) -c:a aac -b:a 128k -flush_packets 1 -max_delay 0 -fflags nobuffer -flags low_delay -f mp4 -movflags frag_keyframe+empty_moov+faststart -frag_duration 100000 \"\(webmFileURL.path)\""
        Logger.debug("[Microphone] Starting FFmpeg with command: \(ffmpegCommand)")
        
        ffmpegSession = FFmpegKit.executeAsync(ffmpegCommand) { session in
            if let returnCode = session?.getReturnCode(), returnCode.isValueSuccess() {
                Logger.debug("[Microphone] FFmpeg process completed successfully")
            } else {
                Logger.debug("[Microphone] FFmpeg process failed: \(session?.getFailStackTrace() ?? "Unknown error")")
            }
        } withLogCallback: { log in
            Logger.debug("[Microphone] FFmpeg log: \(log?.getMessage() ?? "")")
        } withStatisticsCallback: { statistics in
        }
        
        self.ffmpegPipeFileHandle = FileHandle(forWritingAtPath: pipe)
        if self.ffmpegPipeFileHandle == nil {
            Logger.debug("[Microphone] Failed to open pipe for writing")
            return nil
        }
        
        // Return the WebM file URI
        webmFileUri = webmFileURL.absoluteString
        return webmFileURL.absoluteString
    }
    
    private func closeFFmpegPipe() {
        // 確保有最後一個塊再發送通知
        if lastAudioChunkUri != nil {
            // 發送最後一個塊的通知（如果有）
            sendLastChunkNotification()
        }
        
        if let pipe = ffmpegPipe {
            ffmpegPipeFileHandle?.closeFile()
            ffmpegPipeFileHandle = nil
            
            FFmpegKitConfig.closeFFmpegPipe(pipe)
            ffmpegPipe = nil
            Logger.debug("[Microphone] FFmpeg pipe closed")
        }
        
        if let session = ffmpegSession, session.getState() != .completed && session.getState() != .failed {
            FFmpegKit.cancel(session.getId())
            Logger.debug("[Microphone] FFmpeg session cancelled")
        }
        ffmpegSession = nil
    }
    
    // 發送最後一個塊的通知
    private func sendLastChunkNotification() {
        guard let webmFile = webmFile, FileManager.default.fileExists(atPath: webmFile.path) else {
            return
        }
        
        // 只有當這不是一個重複發送的情況時才發送事件
        if !sentChunkIndices.contains(-1) {  // 使用-1作為標記，表示已經發送過最終塊通知
            do {
                // 創建一個新的最終塊文件，使用當前的計數器作為索引（這將是一個新索引）
                let documentsDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
                let finalChunkFileName = "chunk_\(streamUuid)_\(audioChunkCounter).mp4"
                let finalChunkFile = documentsDirectory.appendingPathComponent(finalChunkFileName)
                
                // 複製當前的文件
                try FileManager.default.copyItem(at: webmFile, to: finalChunkFile)
                
                let finalChunkUri = finalChunkFile.absoluteString
                Logger.debug("[Microphone] Creating final chunk with NEW index \(audioChunkCounter)")
                
                // 保存最終塊信息
                finalChunkFileUri = finalChunkUri
                finalChunkIndex = audioChunkCounter
                
                // 發送最終塊事件
                emitChunkUpdate(chunkFileUri: finalChunkUri, chunkIndex: audioChunkCounter, isLastChunk: true)
                
                // 標記已經發送過最終塊通知
                sentChunkIndices.insert(-1)
                
                // 不要增加計數器，因為我們已經停止錄音了
            } catch {
                Logger.debug("[Microphone] Error creating final audio chunk: \(error.localizedDescription)")
            }
        } else {
            Logger.debug("[Microphone] Last chunk notification already sent, skipping duplicate")
        }
    }
    
    // 生成新的音頻塊文件並發送通知
    private func createAndEmitAudioChunk() {
        guard let webmFile = webmFile, FileManager.default.fileExists(atPath: webmFile.path) else {
            return
        }
        
        do {
            // 只在合適的時間間隔後創建塊
            let now = Date()
            if let lastTime = lastAudioChunkTime, now.timeIntervalSince(lastTime) < emissionInterval {
                return // 尚未達到觸發間隔
            }
            
            // 更新最後觸發時間
            lastAudioChunkTime = now
            
            // 創建新的塊文件
            let documentsDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
            let chunkFileName = "chunk_\(streamUuid)_\(audioChunkCounter).mp4"
            let chunkFile = documentsDirectory.appendingPathComponent(chunkFileName)
            
            // 複製當前的文件
            try FileManager.default.copyItem(at: webmFile, to: chunkFile)
            
            // 保存最後一個塊的 URI
            lastAudioChunkUri = chunkFile.absoluteString
            
            // 發送事件
            emitChunkUpdate(chunkFileUri: chunkFile.absoluteString, chunkIndex: audioChunkCounter, isLastChunk: false)
            
            // 記錄此塊已發送
            sentChunkIndices.insert(audioChunkCounter)
            
            // 增加塊計數器
            audioChunkCounter += 1
        } catch {
            Logger.debug("[Microphone] Error creating audio chunk: \(error.localizedDescription)")
        }
    }
    
    // 發送塊更新事件
    private func emitChunkUpdate(chunkFileUri: String, chunkIndex: Int, isLastChunk: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            Logger.debug("[Microphone] About to call delegate onAudioChunkUpdate for chunk \(chunkIndex), isLastChunk: \(isLastChunk), sentIndices: \(self.sentChunkIndices)")
            if self.delegate == nil {
                Logger.debug("[Microphone] WARNING: delegate is nil, event will not be sent")
            }
            
            self.delegate?.onAudioChunkUpdate(
                chunkFileUri: chunkFileUri,
                chunkIndex: chunkIndex,
                streamUuid: self.streamUuid,
                isLastChunk: isLastChunk
            )
            Logger.debug("[Microphone] Emitted chunk update event for chunk \(chunkIndex), isLastChunk: \(isLastChunk), URI: \(chunkFileUri)")
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
        
        // 重置音頻塊跟踪集合
        sentChunkIndices.removeAll()
        
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
        
        // 重置音頻塊跟踪
        audioChunkCounter = 0
        lastAudioChunkTime = nil
        
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
        
        // 重置最終塊信息
        finalChunkFileUri = nil
        finalChunkIndex = 0
        
        // Close FFmpeg pipe before stopping recording
        closeFFmpegPipe()
        
        self.isRecording = false
        self.isVoiceProcessingEnabled = false
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        
        // 重置標記，準備下一次錄音
        sentChunkIndices.removeAll()
        
        if let promiseResolver = promise {
            // 只返回 null，因為最終塊的信息已經通過 delegate 的 onAudioChunkUpdate 方法發送
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
            
            // 嘗試創建並發送音頻塊
            createAndEmitAudioChunk()
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
