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
    
    // 音頻塊計數和管理
    private var audioChunkCounter: Int = 0
    private var streamUuid: String = ""
    private var mp4File: URL?
    private var lastAudioChunkSize: Int64 = 0 // 記錄上一次處理的文件大小
    private var fileMonitor: DispatchSourceFileSystemObject?
    private var isPipeClosed: Bool = false // 記錄pipe是否已關閉
    
    // 添加一個映射來跟踪哪些塊已經發送過
    private var sentChunkIndices = Set<Int>()
    
    // FFmpeg 完成狀態
    private var isFFmpegCompleted: Bool = false
    
    // 用於檔案監控的debounce
    private var fileChangeDebounceTimer: Timer?
    private var chunkCreationDebounceTimer: Timer?
    
    // 標記是否需要處理最後的塊
    private var needFinalChunk: Bool = false
    
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
        let mp4FileName = "audio_\(streamUuid).mp4"
        let mp4FileUrl = documentsDirectory.appendingPathComponent(mp4FileName)
        mp4File = mp4FileUrl
        
        // 重置所有狀態
        sentChunkIndices.removeAll()
        audioChunkCounter = 0
        lastAudioChunkSize = 0
        isPipeClosed = false
        isFFmpegCompleted = false
        
        // 創建一個空文件 - 這樣我們可以監聽它
        fileManager.createFile(atPath: mp4FileUrl.path, contents: nil)
        
        // Register a new FFmpeg pipe
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
        
        // 使用 -y 參數強制覆蓋已存在的文件
        let ffmpegCommand = "-f \(format) -ar \(sampleRate) -ac \(channels) -i \(pipe) -c:a aac -b:a 128k -flush_packets 1 -max_delay 0 -fflags nobuffer -flags low_delay -f mp4 -movflags frag_keyframe+empty_moov+faststart -frag_duration 100000 -y \"\(mp4FileUrl.path)\""
        Logger.debug("[Microphone] Starting FFmpeg with command: \(ffmpegCommand)")
        
        // 設置FFmpeg會話並處理完成回調
        ffmpegSession = FFmpegKit.executeAsync(ffmpegCommand) { [weak self] session in
            guard let self = self else { return }
            
            let state = session?.getState() ?? .failed
            let returnCode = session?.getReturnCode()
            
            // 檢查退出程序
            let exitCode = returnCode?.getValue() ?? -1
            let exitingNormally = session?.getOutput()?.contains("Exiting normally") ?? false
            
            if let returnCode = returnCode, returnCode.isValueSuccess() {
                Logger.debug("[Microphone] FFmpeg process completed successfully with return code: \(returnCode.getValue())")
                
                DispatchQueue.main.async {
                    self.isFFmpegCompleted = true
                    
                    // 如果檔案還在監控中，則發送最後一個塊
                    if self.fileMonitor != nil {
                        Logger.debug("[Microphone] FFmpeg completed, sending final chunk")
                        self.createAndEmitAudioChunk(isLastChunk: true)
                    }
                }
            } else if exitingNormally {
                // 正常取消的情況
                Logger.debug("[Microphone] FFmpeg process cancelled normally with exit code: \(exitCode)")
                
                DispatchQueue.main.async {
                    self.isFFmpegCompleted = true
                    
                    // 確保在取消後也發送最後一個塊
                    if self.fileMonitor != nil {
                        Logger.debug("[Microphone] FFmpeg cancelled, sending final chunk")
                        self.needFinalChunk = true
                        self.createAndEmitAudioChunk(isLastChunk: true)
                    }
                }
            } else {
                let failStackTrace = session?.getFailStackTrace() ?? "Unknown error"
                Logger.debug("[Microphone] FFmpeg process failed with state \(state): \(failStackTrace)")
                
                DispatchQueue.main.async {
                    self.isFFmpegCompleted = true
                    
                    // 即使是真正的錯誤也嘗試發送最後一個塊
                    if self.fileMonitor != nil && self.needFinalChunk {
                        Logger.debug("[Microphone] FFmpeg failed but still sending final chunk")
                        self.createAndEmitAudioChunk(isLastChunk: true)
                    } else if self.fileMonitor != nil {
                        self.fileMonitor?.cancel()
                        self.fileMonitor = nil
                        Logger.debug("[Microphone] File monitoring stopped after FFmpeg failure")
                    }
                }
            }
        } withLogCallback: { log in
            let message = log?.getMessage() ?? ""
            // 只記錄重要的日誌，過濾掉冗長的統計信息
            if !message.contains("frame=") && !message.contains("fps=") {
                Logger.debug("[Microphone] FFmpeg log: \(message)")
            }
        } withStatisticsCallback: { statistics in
            // 可以使用統計回調來監控處理進度
        }
        
        self.ffmpegPipeFileHandle = FileHandle(forWritingAtPath: pipe)
        if self.ffmpegPipeFileHandle == nil {
            Logger.debug("[Microphone] Failed to open pipe for writing")
            return nil
        }
        
        // 設置文件監聽
        setupFileMonitoring(for: mp4FileUrl)
        
        // Return the WebM file URI
        webmFileUri = mp4FileUrl.absoluteString
        return mp4FileUrl.absoluteString
    }
    
    // 設置文件監聽
    private func setupFileMonitoring(for fileURL: URL) {
        // 關閉之前的監聽（如果有）
        fileMonitor?.cancel()
        fileMonitor = nil
        
        // 打開文件以獲取文件描述符
        guard let fileHandle = try? FileHandle(forReadingFrom: fileURL),
              let fileDescriptor = try? fileHandle.fileDescriptor else {
            Logger.debug("[Microphone] Failed to get file descriptor for monitoring")
            return
        }
        
        // 創建文件系統監聽
        let monitor = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fileDescriptor,
            eventMask: .write, // 監聽文件寫入事件
            queue: DispatchQueue.global(qos: .background)
        )
        
        // 設置事件處理程序
        monitor.setEventHandler { [weak self] in
            guard let self = self else { return }
            self.handleFileChange()
        }
        
        // 設置取消處理程序
        monitor.setCancelHandler {
            try? fileHandle.close()
        }
        
        // 啟動監聽
        monitor.resume()
        fileMonitor = monitor
        Logger.debug("[Microphone] File monitoring started for \(fileURL.lastPathComponent)")
    }
    
    // 處理文件變化 - 使用debounce避免頻繁觸發
    private func handleFileChange() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            // 取消先前的timer
            self.fileChangeDebounceTimer?.invalidate()
            
            // 設置新的timer（300毫秒的debounce時間）
            self.fileChangeDebounceTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
                guard let self = self, !self.isFFmpegCompleted else { return }
                
                // 創建並發送塊
                self.createAndEmitAudioChunk(isLastChunk: false)
            }
        }
    }
    
    private func closeFFmpegPipe() {
        // 標記pipe已關閉
        isPipeClosed = true
        Logger.debug("[Microphone] Marking FFmpeg pipe as closed")
        
        // 標記需要處理最後一個塊
        needFinalChunk = true
        
        // 確保所有數據都已寫入
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
        
        if let session = ffmpegSession {
            let state = session.getState()
            Logger.debug("[Microphone] FFmpeg session state before handling: \(state)")
            
            // 如果會話仍在運行，則取消它
            if state != .completed && state != .failed {
                // 在取消前等待一小段時間，讓FFmpeg處理最後的數據
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    guard let self = self else { return }
                    FFmpegKit.cancel(session.getId())
                    Logger.debug("[Microphone] FFmpeg session cancelled")
                }
            } else {
                // 如果會話已經完成，設置標記
                isFFmpegCompleted = true
                Logger.debug("[Microphone] FFmpeg was already completed")
                
                // 確保發送最後一個塊
                DispatchQueue.main.async { [weak self] in
                    guard let self = self else { return }
                    self.createAndEmitAudioChunk(isLastChunk: true)
                }
            }
        }
        
        ffmpegSession = nil
    }
    
    // 生成新的音頻塊文件並發送通知
    private func createAndEmitAudioChunk(isLastChunk: Bool) {
        // 取消之前的debounce timer
        chunkCreationDebounceTimer?.invalidate()
        
        // 創建新的timer，但對於最後一個塊減少延遲
        let debounceTime = isLastChunk ? 0.1 : 0.3
        
        chunkCreationDebounceTimer = Timer.scheduledTimer(withTimeInterval: debounceTime, repeats: false) { [weak self] _ in
            guard let self = self, let mp4FileURL = self.mp4File, FileManager.default.fileExists(atPath: mp4FileURL.path) else {
                Logger.debug("[Microphone] MP4 file does not exist, skipping chunk creation")
                return
            }
            
            do {
                // 獲取當前文件大小
                let fileAttributes = try FileManager.default.attributesOfItem(atPath: mp4FileURL.path)
                guard let fileSize = fileAttributes[.size] as? Int64 else {
                    Logger.debug("[Microphone] Unable to get file size")
                    return
                }
                
                // 檢查文件是否有增長，但對於最後一個塊，即使沒有增長也處理
                if fileSize <= self.lastAudioChunkSize && !isLastChunk && !self.needFinalChunk {
                    Logger.debug("[Microphone] File size not increased (current: \(fileSize), last: \(self.lastAudioChunkSize)), skipping")
                    return
                }
                
                // 創建新的塊文件
                let documentsDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
                let chunkFileName = "chunk_\(self.streamUuid)_\(self.audioChunkCounter).mp4"
                let chunkFile = documentsDirectory.appendingPathComponent(chunkFileName)
                
                // 打開原始文件進行讀取
                let fileHandle = try FileHandle(forReadingFrom: mp4FileURL)
                
                // 確定讀取的起始位置和長度
                let startOffset = self.lastAudioChunkSize
                let length = fileSize - startOffset
                
                // 如果長度為零，且不是最後一個需要的塊，則跳過
                if length == 0 && !(isLastChunk && self.needFinalChunk) {
                    Logger.debug("[Microphone] Zero length chunk, skipping")
                    try fileHandle.close()
                    
                    // 如果是最後一個塊但沒有新數據，也需要停止監聽
                    if isLastChunk || self.isFFmpegCompleted {
                        self.fileMonitor?.cancel()
                        self.fileMonitor = nil
                        Logger.debug("[Microphone] File monitoring stopped after final chunk (no new data)")
                    }
                    return
                }
                
                // 尋找到起始位置
                try fileHandle.seek(toOffset: UInt64(startOffset))
                
                // 讀取新增的數據
                let chunkData = fileHandle.readDataToEndOfFile()
                try fileHandle.close()
                
                // 如果數據為空，但需要發送最後一個塊，則仍然繼續
                if chunkData.isEmpty && !(isLastChunk && self.needFinalChunk) {
                    Logger.debug("[Microphone] Empty chunk data, skipping")
                    
                    // 如果是最後一個塊但沒有新數據，也需要停止監聽
                    if isLastChunk || self.isFFmpegCompleted {
                        self.fileMonitor?.cancel()
                        self.fileMonitor = nil
                        Logger.debug("[Microphone] File monitoring stopped after final chunk (empty data)")
                    }
                    return
                }
                
                // 如果有數據，寫入新的塊文件
                if !chunkData.isEmpty {
                    try chunkData.write(to: chunkFile)
                    
                    // 更新最後處理的文件大小
                    self.lastAudioChunkSize = fileSize
                    
                    // 確定是否為最後一個塊 - 如果是手動觸發的最後一個塊或FFmpeg已完成
                    let finalIsLastChunk = isLastChunk || self.isFFmpegCompleted
                    
                    // 發送事件
                    self.emitChunkUpdate(chunkFileUri: chunkFile.absoluteString, chunkIndex: self.audioChunkCounter, isLastChunk: finalIsLastChunk)
                    
                    // 記錄此塊已發送
                    self.sentChunkIndices.insert(self.audioChunkCounter)
                    
                    // 增加塊計數器
                    self.audioChunkCounter += 1
                    
                    Logger.debug("[Microphone] Created and emitted chunk \(self.audioChunkCounter-1) with size \(chunkData.count) bytes, isLastChunk: \(finalIsLastChunk)")
                } else if isLastChunk && self.needFinalChunk {
                    // 如果是最後一個塊但沒有新數據，發送最後一個塊的標記
                    Logger.debug("[Microphone] No new data for final chunk, sending last chunk marker only")
                    self.emitChunkUpdate(
                        chunkFileUri: "",  // 空URI表示沒有新文件
                        chunkIndex: -1,    // 特殊索引表示沒有新塊
                        isLastChunk: true  // 但這是最後一個
                    )
                }
                
                // 如果這是最後一個塊或FFmpeg已完成，停止文件監聽
                if isLastChunk || self.isFFmpegCompleted {
                    self.fileMonitor?.cancel()
                    self.fileMonitor = nil
                    Logger.debug("[Microphone] File monitoring stopped after final chunk")
                    
                    // 重置標記
                    self.needFinalChunk = false
                }
            } catch {
                Logger.debug("[Microphone] Error creating audio chunk: \(error.localizedDescription)")
                
                // 如果處理最後一個塊時出錯，確保停止監聽
                if isLastChunk || self.isFFmpegCompleted {
                    self.fileMonitor?.cancel()
                    self.fileMonitor = nil
                    Logger.debug("[Microphone] File monitoring stopped after error in final chunk")
                }
            }
        }
    }
    
    // 發送塊更新事件
    private func emitChunkUpdate(chunkFileUri: String, chunkIndex: Int, isLastChunk: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            Logger.debug("[Microphone] Emitting chunk update for chunk \(chunkIndex), isLastChunk: \(isLastChunk), processedSize: \(self.lastAudioChunkSize)")
            
            self.delegate?.onAudioChunkUpdate(
                chunkFileUri: chunkFileUri,
                chunkIndex: chunkIndex,
                streamUuid: self.streamUuid,
                isLastChunk: isLastChunk
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
        Logger.debug("Debug: Audio session is successfully configured. Actual sample rate is \(actualSampleRate) Hz")
        
        recordingSettings = newSettings  // Update the class property with the new settings
        
        // 重置狀態
        isPipeClosed = false
        isFFmpegCompleted = false
        
        // Set up FFmpeg pipe for WebM recording
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
                webmFileUri: mp4Uri,
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
        
        // 先處理最後的音頻數據
        if !accumulatedData.isEmpty && ffmpegPipeFileHandle != nil {
            Logger.debug("[Microphone] Writing final accumulated data (\(accumulatedData.count) bytes) to FFmpeg pipe")
            ffmpegPipeFileHandle?.write(accumulatedData)
            accumulatedData.removeAll()
        }
        
        // 關閉FFmpeg管道 - 這會觸發最終處理
        closeFFmpegPipe()
        
        // 停止錄製
        self.isRecording = false
        self.isVoiceProcessingEnabled = false
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        
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

        // 處理採樣率轉換
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
        
        // 計算音量等級
        let powerLevel: Float = AudioUtils.calculatePowerLevel(from: finalBuffer)
        
        // 獲取音頻數據
        let audioData = finalBuffer.audioBufferList.pointee.mBuffers
        guard let bufferData = audioData.mData else {
            Logger.debug("[Microphone] Buffer data is nil.")
            return
        }
        
        // 處理靜音模式
        let data = isSilent
                    ? Data(repeating: 0, count:
                            Int(finalBuffer.frameCapacity) * Int(finalBuffer.format.streamDescription.pointee.mBytesPerFrame))
                    : Data(bytes: bufferData, count: Int(audioData.mDataByteSize))
        
        // 累積數據
        accumulatedData.append(data)
        totalDataSize += Int64(data.count)
        
        // 根據間隔或停止錄製決定是否發送數據
        let currentTime = Date()
        let intervalElapsed = lastEmissionTime == nil || currentTime.timeIntervalSince(lastEmissionTime!) >= emissionInterval
        
        // 如果達到發送間隔或錄製已停止，則發送數據
        if intervalElapsed || !isRecording {
            if let startTime = startTime {
                // 複製累積的數據進行處理
                let dataToProcess = accumulatedData
                
                // 通知代理有新的麥克風數據
                self.delegate?.onMicrophoneData(dataToProcess, powerLevel)
                
                // 將數據寫入FFmpeg管道
                if let fileHandle = ffmpegPipeFileHandle, !dataToProcess.isEmpty {
                    fileHandle.write(dataToProcess)
                    Logger.debug("[Microphone] Wrote \(dataToProcess.count) bytes to FFmpeg pipe")
                }
                
                // 更新最後發送時間和大小
                self.lastEmissionTime = currentTime
                self.lastEmittedSize = totalDataSize
                accumulatedData.removeAll()
            }
        }
    }
}
