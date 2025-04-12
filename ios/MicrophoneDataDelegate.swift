protocol MicrophoneDataDelegate: AnyObject {
    func onAudioChunkUpdate(chunkFileUri: String, chunkIndex: Int, streamUuid: String, isLastChunk: Bool, length: Int64)
}
