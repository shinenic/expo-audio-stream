// RecordingResult.swift

struct RecordingResult {
    var mp4FileUri: String?
    var filename: String?
    var mimeType: String?
    var duration: Int64?
    var size: Int64?
    var channels: Int?
    var bitDepth: Int?
    var sampleRate: Double?
    var error: String?
    
}

struct StartRecordingResult {
    var mp4FileUri: String?
    var mimeType: String?
    var channels: Int?
    var bitDepth: Int?
    var sampleRate: Double?
    var error: String?
}
