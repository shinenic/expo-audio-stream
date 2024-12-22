import AVFoundation
import ExpoModulesCore

class SoundPlayer {
    private var audioEngine: AVAudioEngine!

    private var inputNode: AVAudioInputNode!
    private var audioPlayerNode: AVAudioPlayerNode!
    
    private var isMuted = false
    private var isVoiceProcessingEnabled: Bool = false
    
    private let bufferAccessQueue = DispatchQueue(label: "com.kinexpoaudiostream.bufferAccessQueue")
    
    private var audioQueue: [(buffer: AVAudioPCMBuffer, promise: RCTPromiseResolveBlock, turnId: String)] = []  // Queue for audio segments
    private var isPlaying: Bool = false  // Tracks if audio is currently playing
    private var isInterrupted: Bool = false
    private var isAudioEngineIsSetup: Bool = false
    public static let isLinear16PCM: Bool = true
  
    private let audioPlaybackFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000.0, channels: 1, interleaved: false)
    
    
    private func ensureAudioEngineIsSetup() throws {
        self.audioEngine = AVAudioEngine()
                    
        audioPlayerNode = AVAudioPlayerNode()
        if let playerNode = self.audioPlayerNode {
            audioEngine.attach(playerNode)
            audioEngine.connect(playerNode, to: audioEngine.mainMixerNode, format: self.audioPlaybackFormat)
        }
        self.isAudioEngineIsSetup = true
        
        try self.audioEngine.start()
    }
    
    func clearAudioQueue(_ promise: Promise) {
        Logger.debug("[SoundPlayer] Clearing Audio Queue...")
        if !self.audioQueue.isEmpty {
            Logger.debug("[SoundPlayer] Queue is not empty clearing")
            self.audioQueue.removeAll()
        } else {
            Logger.debug("[SoundPlayer] Queue is empty")
        }
        promise.resolve(nil)
    }
    
    
    func stop(_ promise: Promise) {
        Logger.debug("[SoundPlayer] Stopping Audio")
        if !self.audioQueue.isEmpty {
            Logger.debug("[SoundPlayer] Queue is not empty clearing")
            self.audioQueue.removeAll()
        }
          // Stop the audio player node
        if self.audioPlayerNode != nil && self.audioPlayerNode.isPlaying {
            Logger.debug("[SoundPlayer] Player is playing stopping")
            self.audioPlayerNode.pause()
            self.audioPlayerNode.stop()
            
            self.isPlaying = false
        } else {
            Logger.debug("Player is not playing")
        }
        promise.resolve(nil)
    }
    
    func interrupt(_ promise: Promise) {
        self.isInterrupted = true
        self.stop(promise)
    }
    
    func resume() {
        self.isInterrupted = false
    }
    
    
    public func play(
        audioChunk base64String: String,
        turnId strTurnId: String,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) throws {
        Logger.debug("New play chunk \(self.isInterrupted)")
        guard !self.isInterrupted else {
            resolver(nil)
            return
        }
        do {
            if !self.isAudioEngineIsSetup {
                try ensureAudioEngineIsSetup()
            }
            
            guard let data = Data(base64Encoded: base64String) else {
                Logger.debug("[SoundPlayer] Failed to decode base64 string")
                throw SoundPlayerError.invalidBase64String
            }
            guard let pcmData = AudioUtils.removeRIFFHeaderIfNeeded(from: data),
                  let pcmBuffer = AudioUtils.convertPCMDataToBuffer(pcmData, audioFormat: self.audioPlaybackFormat!) else {
                Logger.debug("[SoundPlayer] Failed to process audio chunk")
                return
            }
            let bufferTuple = (buffer: pcmBuffer, promise: resolver, turnId: strTurnId)
            audioQueue.append(bufferTuple)
            print("New Chunk \(isPlaying)")
            // If not already playing, start playback
            playNextInQueue()
        } catch {
            Logger.debug("[SoundPlayer] Failed to enqueue audio chunk: \(error.localizedDescription)")
            rejecter("ERROR_SOUND_PLAYER", "Failed to enqueue audio chunk: \(error.localizedDescription)", nil)
        }
    }
    
    
    private func playNextInQueue() {
        guard !audioQueue.isEmpty else {
            return
        }
        guard !isPlaying else {
            return
        }
        
        Logger.debug("[SoundPlayer] Playing audio [ \(audioQueue.count)]")
          
            
        if !self.audioPlayerNode.isPlaying {
            Logger.debug("[SoundPlayer] Starting Player")
            self.audioPlayerNode.play()
        }
        self.bufferAccessQueue.async {
            if let (buffer, promise, _) = self.audioQueue.first {
                self.audioQueue.removeFirst()

                self.audioPlayerNode.scheduleBuffer(buffer) {
                    promise(nil)
                    

                    let bufferDuration = Double(buffer.frameLength) / buffer.format.sampleRate
                    if !self.isInterrupted && !self.audioQueue.isEmpty {
                        self.playNextInQueue()
                    }
                }
            }
        }
    }
}

