protocol MicrophoneDataDelegate: AnyObject {
    func onMicrophoneData(_ microphoneData: Data, _ soundLevel: Float?)
    func onAudioChunkUpdate(chunkFileUri: String, chunkIndex: Int, streamUuid: String, isLastChunk: Bool, length: Int64)
}
