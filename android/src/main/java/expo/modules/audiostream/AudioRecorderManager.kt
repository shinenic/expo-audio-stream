package expo.modules.audiostream

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.os.bundleOf
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFmpegKitConfig
import com.arthenica.ffmpegkit.ReturnCode
import expo.modules.kotlin.Promise
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicBoolean


class AudioRecorderManager(
    private val filesDir: File,
    private val permissionUtils: PermissionUtils,
    private val audioDataEncoder: AudioDataEncoder,
    private val eventSender: EventSender,
    private val context: android.content.Context
) {
    private var audioRecord: AudioRecord? = null
    private var bufferSizeInBytes = 0
    private var isRecording = AtomicBoolean(false)
    private val isPaused = AtomicBoolean(false)
    private var streamUuid: String? = null
    private var webmFile: File? = null
    private var ffmpegPipe: String? = null
    private var pipeFos: FileOutputStream? = null
    private var recordingThread: Thread? = null
    private var recordingStartTime: Long = 0
    private var totalRecordedTime: Long = 0
    private var totalDataSize = 0
    private var interval = 1000L  // Emit data every 1000 milliseconds (1 second)
    private var lastEmitTime = SystemClock.elapsedRealtime()
    private var lastPauseTime = 0L
    private var pausedDuration = 0L
    private var lastEmittedSize = 0L
    private val mainHandler = Handler(Looper.getMainLooper())
    private val audioRecordLock = Any()
    private var audioFileHandler: AudioFileHandler = AudioFileHandler(filesDir)
    // Buffer to hold accumulated PCM data between emissions
    private val pcmBuffer = ByteArrayOutputStream()
    
    // Added for chunk tracking
    private var chunkCounter = 0
    private val CHUNK_SIZE_THRESHOLD = 50 * 1024L // 50KB in bytes - changed to Long with L suffix
    private var lastProcessedSize = 0L

    private lateinit var recordingConfig: RecordingConfig
    private var mimeType = "audio/wav"
    private var audioFormat: Int = AudioFormat.ENCODING_PCM_16BIT

    // 創建新的實例變數，用於跟踪最後一個塊文件以及最後一次塊創建的時間
    private var lastChunkFile: File? = null
    private var lastChunkCreationTime: Long = 0

    // 添加一個集合來跟踪已發送的塊索引
    private val sentChunkIndices = mutableSetOf<Int>()
    private var sentFinalChunk = false
    
    // 添加跟踪最終塊信息的變量
    private var finalChunkFileUri: String? = null
    private var finalChunkIndex: Int = -1

    @RequiresApi(Build.VERSION_CODES.R)
    fun startRecording(options: Map<String, Any?>, promise: Promise) {
        if (!permissionUtils.checkRecordingPermission()) {
            promise.reject("PERMISSION_DENIED", "Recording permission has not been granted", null)
            return
        }

        if (isRecording.get() && !isPaused.get()) {
            promise.reject("ALREADY_RECORDING", "Recording is already in progress", null)
            return
        }

        // Initialize the recording configuration
        var tempRecordingConfig = RecordingConfig(
            sampleRate = (options["sampleRate"] as? Number)?.toInt() ?: Constants.DEFAULT_SAMPLE_RATE,
            channels = (options["channels"] as? Number)?.toInt() ?: 1,
            encoding = options["encoding"] as? String ?: "pcm_16bit",
            interval = (options["interval"] as? Number)?.toLong() ?: Constants.DEFAULT_INTERVAL,
            pointsPerSecond = (options["pointsPerSecond"] as? Number)?.toDouble() ?: 20.0
        )
        Log.d(Constants.TAG, "Initial recording configuration: $tempRecordingConfig")

        // Validate sample rate and channels
        if (tempRecordingConfig.sampleRate !in listOf(16000, 44100, 48000)) {
            promise.reject(
                "INVALID_SAMPLE_RATE",
                "Sample rate must be one of 16000, 44100, or 48000 Hz",
                null
            )
            return
        }
        if (tempRecordingConfig.channels !in 1..2) {
            promise.reject(
                "INVALID_CHANNELS",
                "Channels must be either 1 (Mono) or 2 (Stereo)",
                null
            )
            return
        }

        // Set encoding and file extension
        audioFormat = when (tempRecordingConfig.encoding) {
            "pcm_8bit" -> {
                mimeType = "audio/pcm"
                AudioFormat.ENCODING_PCM_8BIT
            }
            "pcm_16bit" -> {
                mimeType = "audio/pcm"
                AudioFormat.ENCODING_PCM_16BIT
            }
            "pcm_32bit" -> {
                mimeType = "audio/pcm"
                AudioFormat.ENCODING_PCM_FLOAT
            }
            "opus" -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    promise.reject(
                        "UNSUPPORTED_FORMAT",
                        "Opus encoding not supported on this Android version.",
                        null
                    )
                    return
                }
                mimeType = "audio/opus"
                AudioFormat.ENCODING_OPUS
            }
            "aac_lc" -> {
                mimeType = "audio/aac"
                AudioFormat.ENCODING_AAC_LC
            }
            else -> {
                mimeType = "audio/pcm"
                AudioFormat.ENCODING_DEFAULT
            }
        }

        // Check if selected audio format is supported
        if (!isAudioFormatSupported(tempRecordingConfig.sampleRate, tempRecordingConfig.channels, audioFormat)) {
            Log.e(Constants.TAG, "Selected audio format not supported, falling back to 16-bit PCM")
            audioFormat = AudioFormat.ENCODING_PCM_16BIT
            if (!isAudioFormatSupported(tempRecordingConfig.sampleRate, tempRecordingConfig.channels, audioFormat)) {
                promise.reject("INITIALIZATION_FAILED", "Failed to initialize audio recorder with any supported format", null)
                return
            }
            tempRecordingConfig = tempRecordingConfig.copy(encoding = "pcm_16bit")
        }

        // Update recordingConfig with potentially new encoding
        recordingConfig = tempRecordingConfig

        interval = recordingConfig.interval

        // Recalculate bufferSizeInBytes if the format has changed
        bufferSizeInBytes = AudioRecord.getMinBufferSize(
            recordingConfig.sampleRate,
            if (recordingConfig.channels == 1) AudioFormat.CHANNEL_IN_MONO else AudioFormat.CHANNEL_IN_STEREO,
            audioFormat
        )

        if (bufferSizeInBytes == AudioRecord.ERROR || bufferSizeInBytes == AudioRecord.ERROR_BAD_VALUE || bufferSizeInBytes < 0) {
            Log.e(Constants.TAG, "Failed to get minimum buffer size, falling back to default buffer size.")
            bufferSizeInBytes = 4096 // Default buffer size in bytes
        }

        Log.d(Constants.TAG, "AudioFormat: $audioFormat, BufferSize: $bufferSizeInBytes")

        // Initialize the AudioRecord if it's a new recording or if it's not currently paused
        if (audioRecord == null || !isPaused.get()) {
            Log.d(Constants.TAG, "AudioFormat: $audioFormat, BufferSize: $bufferSizeInBytes")

            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                recordingConfig.sampleRate,
                if (recordingConfig.channels == 1) AudioFormat.CHANNEL_IN_MONO else AudioFormat.CHANNEL_IN_STEREO,
                audioFormat,
                bufferSizeInBytes
            )
            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                promise.reject(
                    "INITIALIZATION_FAILED",
                    "Failed to initialize the audio recorder",
                    null
                )
                return
            }
        }

        streamUuid = java.util.UUID.randomUUID().toString()
        webmFile = File(filesDir, "audio_${streamUuid}.mp4")
        
        // Reset the PCM buffer
        pcmBuffer.reset()
        
        // Reset chunk tracking
        chunkCounter = 0
        lastChunkFile = null
        lastChunkCreationTime = 0
        lastProcessedSize = 0L
        sentChunkIndices.clear()
        sentFinalChunk = false
        
        // 重置最終塊信息
        finalChunkFileUri = null
        finalChunkIndex = -1

        // Set up FFmpeg pipe for WebM conversion
        try {
            // 1. Create pipe
            ffmpegPipe = FFmpegKitConfig.registerNewFFmpegPipe(context)
            Log.d(Constants.TAG, "Created FFmpeg pipe: $ffmpegPipe")
            
            // 2. Build FFmpeg command to encode to WebM
            val bitDepth = when (recordingConfig.encoding) {
                "pcm_8bit" -> 8
                "pcm_16bit" -> 16
                "pcm_32bit" -> 32
                else -> 16
            }
            
            val pcmFormat = when (bitDepth) {
                8 -> "u8"
                16 -> "s16le"
                32 -> "f32le"
                else -> "s16le"
            }
            
            // Safely get the webmFile path
            val webmFilePath = webmFile?.absolutePath ?: run {
                Log.e(Constants.TAG, "WebM file path is null")
                throw IOException("WebM file path is null")
            }

            // add a few tolerance to the fragDuration
            val fragDuration = interval * 1000 + 1000 // microseconds
            
            val ffmpegCommand = "-f $pcmFormat -ar ${recordingConfig.sampleRate} -ac ${recordingConfig.channels} " +
                    "-i $ffmpegPipe -c:a aac -b:a 128k -flush_packets 1 -f mp4 -movflags frag_keyframe+empty_moov+faststart -frag_duration $fragDuration $webmFilePath"
                    // "-f $pcmFormat -ar ${recordingConfig.sampleRate} -ac ${recordingConfig.channels} -i $ffmpegPipe -c:a aac -b:a 128k -flush_packets 1 -max_delay 0 -fflags nobuffer -flags low_delay -f mp4 -movflags frag_keyframe+empty_moov+faststart -frag_duration 100000 $webmFilePath"
            
            // 3. Execute FFmpeg command
            FFmpegKit.executeAsync(ffmpegCommand, { session ->
                val returnCode = session.returnCode
                Log.d(Constants.TAG, "FFmpeg session completed with return code: $returnCode")
                if (ReturnCode.isSuccess(returnCode)) {
                    Log.d(Constants.TAG, "WebM conversion successful")
                } else if (ReturnCode.isCancel(returnCode)) {
                    Log.d(Constants.TAG, "WebM conversion canceled")
                } else {
                    Log.e(Constants.TAG, "WebM conversion failed: ${session.failStackTrace}")
                }
            }, { log ->
                Log.d(Constants.TAG, "FFmpeg log: ${log.message}")
            }, null)
            
            // Open pipe for writing
            pipeFos = ffmpegPipe?.let { FileOutputStream(it) }
            
        } catch (e: Exception) {
            Log.e(Constants.TAG, "Failed to set up FFmpeg pipe", e)
            // Continue even if WebM setup fails
        }

        audioRecord?.startRecording()
        isPaused.set(false)
        isRecording.set(true)

        if (!isPaused.get()) {
            recordingStartTime = System.currentTimeMillis() // Only reset start time if it's not a resume
        }

        recordingThread = Thread { recordingProcess() }.apply { start() }

        val result = bundleOf(
            "webmFileUri" to webmFile?.toURI().toString(),
            "channels" to recordingConfig.channels,
            "bitDepth" to when (recordingConfig.encoding) {
                "pcm_8bit" -> 8
                "pcm_16bit" -> 16
                "pcm_32bit" -> 32
                else -> 16 // Default to 16 if the encoding is not recognized
            },
            "sampleRate" to recordingConfig.sampleRate,
            "mimeType" to mimeType
        )
        promise.resolve(result)
    }

    private fun isAudioFormatSupported(sampleRate: Int, channels: Int, format: Int): Boolean {
        if (!permissionUtils.checkRecordingPermission()) {
            throw SecurityException("Recording permission has not been granted")
        }

        val channelConfig = if (channels == 1) AudioFormat.CHANNEL_IN_MONO else AudioFormat.CHANNEL_IN_STEREO
        val bufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, format)

        if (bufferSize <= 0) {
            return false
        }

        val audioRecord = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            sampleRate,
            channelConfig,
            format,
            bufferSize
        )

        val isSupported = audioRecord.state == AudioRecord.STATE_INITIALIZED
        if (isSupported) {
            val testBuffer = ByteArray(bufferSize)
            audioRecord.startRecording()
            val testRead = audioRecord.read(testBuffer, 0, bufferSize)
            audioRecord.stop()
            if (testRead < 0) {
                return false
            }
        }

        audioRecord.release()
        return isSupported
    }

    fun stopRecording(promise: Promise) {
        synchronized(audioRecordLock) {

            if (!isRecording.get()) {
                Log.e(Constants.TAG, "Recording is not active")
                promise.resolve(null)
                return
            }

            try {
                val audioData = ByteArray(bufferSizeInBytes)
                val bytesRead = audioRecord?.read(audioData, 0, bufferSizeInBytes) ?: -1
                Log.d(Constants.TAG, "Last Read $bytesRead bytes")
                if (bytesRead > 0) {
                    emitAudioData(audioData, bytesRead)
                    // Write final data to pipe
                    pipeFos?.write(audioData, 0, bytesRead)
                }
                
                // 直接處理最後一個塊，標記為最後一個
                processLastChunk()

                Log.d(Constants.TAG, "Stopping recording state = ${audioRecord?.state}")
                if (audioRecord != null && audioRecord!!.state == AudioRecord.STATE_INITIALIZED) {
                    Log.d(Constants.TAG, "Stopping AudioRecord");
                    audioRecord!!.stop()
                }
                
                // Close the pipe
                try {
                    pipeFos?.close()
                    ffmpegPipe?.let {
                        FFmpegKitConfig.closeFFmpegPipe(it)
                        Log.d(Constants.TAG, "Closed FFmpeg pipe: $it")
                    }
                } catch (e: Exception) {
                    Log.e(Constants.TAG, "Error closing FFmpeg pipe", e)
                }
            } catch (e: IllegalStateException) {
                Log.e(Constants.TAG, "Error reading from AudioRecord", e);
            } finally {
                audioRecord?.release()
            }

            try {
                // Calculate duration based on total data size and byte rate
                val byteRate = recordingConfig.sampleRate * recordingConfig.channels * when (recordingConfig.encoding) {
                    "pcm_8bit" -> 1
                    "pcm_16bit" -> 2
                    "pcm_32bit" -> 4
                    else -> 2 // Default to 2 bytes per sample if the encoding is not recognized
                }
                val duration = if (byteRate > 0) (totalDataSize * 1000 / byteRate) else 0

                // Create result bundle
                val resultBuilder = bundleOf(
                    "webmFileUri" to webmFile?.toURI().toString(),
                    "filename" to webmFile?.name,
                    "durationMs" to duration,
                    "channels" to recordingConfig.channels,
                    "bitDepth" to when (recordingConfig.encoding) {
                        "pcm_8bit" -> 8
                        "pcm_16bit" -> 16
                        "pcm_32bit" -> 32
                        else -> 16 // Default to 16 if the encoding is not recognized
                    },
                    "sampleRate" to recordingConfig.sampleRate,
                    "size" to totalDataSize,
                    "mimeType" to mimeType
                )
                
                // JavaScript端現在已經依賴於通過onAudioChunkUpdate事件接收最終塊的信息（isLastChunk=true）
                // 因此我們不需要在結果對象中包含這些信息，但保留注釋以供參考
                // 如果將來需要修改為在結果中包含這些信息，取消下面的註釋：
                /*
                if (finalChunkFileUri != null && finalChunkIndex >= 0) {
                    resultBuilder.putString("finalChunkFileUri", finalChunkFileUri)
                    resultBuilder.putInt("finalChunkIndex", finalChunkIndex)
                }
                */
                
                promise.resolve(resultBuilder)

                // Reset the timing variables
                isRecording.set(false)
                isPaused.set(false)
                totalRecordedTime = 0
                pausedDuration = 0
                totalDataSize = 0
                pcmBuffer.reset()
                
                // Reset chunk tracking
                chunkCounter = 0
                lastChunkFile = null
                lastChunkCreationTime = 0
                sentChunkIndices.clear()
                sentFinalChunk = false
                
                // 重置最終塊信息
                finalChunkFileUri = null
                finalChunkIndex = -1
            } catch (e: Exception) {
                Log.d(Constants.TAG, "Failed to stop recording", e)
                promise.reject("STOP_FAILED", "Failed to stop recording", e)
            } finally {
                audioRecord = null
            }
        }
    }

    fun pauseRecording(promise: Promise) {
        if (isRecording.get() && !isPaused.get()) {
            audioRecord?.stop()
            lastPauseTime =
                System.currentTimeMillis()  // Record the time when the recording was paused
            isPaused.set(true)
            promise.resolve("Recording paused")
        } else {
            promise.reject(
                "NOT_RECORDING_OR_ALREADY_PAUSED",
                "Recording is either not active or already paused",
                null
            )
        }
    }

    fun resumeRecording(promise: Promise) {
        if (isRecording.get() && !isPaused.get()) {
            promise.reject("NOT_PAUSED", "Recording is not paused", null)
            return
        } else if (audioRecord == null) {
            promise.reject("NOT_RECORDING", "Recording is not active", null)
        }

        // Calculate the duration the recording was paused
        pausedDuration += System.currentTimeMillis() - lastPauseTime
        isPaused.set(false)
        audioRecord?.startRecording()
        promise.resolve("Recording resumed")
    }

    fun getStatus(): Bundle {
        synchronized(audioRecordLock) {
            if (!isRecording.get()) {
                Log.d(Constants.TAG, "Not recording --- skip status with default values")

                return bundleOf(
                    "isRecording" to false,
                    "isPaused" to false,
                    "mime" to mimeType,
                    "size" to 0,
                    "interval" to interval,
                )
            }

            // Calculate duration based on total data size and byte rate
            val byteRate = recordingConfig.sampleRate * recordingConfig.channels * when (recordingConfig.encoding) {
                "pcm_8bit" -> 1
                "pcm_16bit" -> 2
                "pcm_32bit" -> 4
                else -> 2
            }
            val duration = if (byteRate > 0) (totalDataSize * 1000 / byteRate) else 0
            
            return bundleOf(
                "durationMs" to duration,
                "isRecording" to isRecording.get(),
                "isPaused" to isPaused.get(),
                "mimeType" to mimeType,
                "size" to totalDataSize,
                "interval" to recordingConfig.interval
            )
        }
    }

    fun listAudioFiles(promise: Promise) {
        val fileList =
            filesDir.list()?.filter { it.endsWith(".wav") }?.map { File(filesDir, it).absolutePath }
                ?: listOf()
        promise.resolve(fileList)
    }

    fun clearAudioStorage(promise: Promise) {
        audioFileHandler.clearAudioStorage()
        promise.resolve(null)
    }

    private fun recordingProcess() {
        Log.i(Constants.TAG, "Starting recording process...")
        
        // Buffer to accumulate data
        val accumulatedAudioData = ByteArrayOutputStream()
        
        // Write audio data directly to the memory buffer
        val audioData = ByteArray(bufferSizeInBytes)
        Log.d(Constants.TAG, "Entering recording loop")
        while (isRecording.get() && !Thread.currentThread().isInterrupted) {
            if (isPaused.get()) {
                // If recording is paused, skip reading from the microphone
                continue
            }

            val bytesRead = synchronized(audioRecordLock) {
                // Only synchronize the read operation and the check
                audioRecord?.let {
                    if (it.state != AudioRecord.STATE_INITIALIZED) {
                        Log.e(Constants.TAG, "AudioRecord not initialized")
                        return@let -1
                    }
                    it.read(audioData, 0, bufferSizeInBytes).also { bytes ->
                        if (bytes < 0) {
                            Log.e(Constants.TAG, "AudioRecord read error: $bytes")
                        }
                    }
                } ?: -1 // Handle null case
            }
            if (bytesRead > 0) {
                totalDataSize += bytesRead
                accumulatedAudioData.write(audioData, 0, bytesRead)
                pcmBuffer.write(audioData, 0, bytesRead)

                // Write data to FFmpeg pipe
                try {
                    pipeFos?.write(audioData, 0, bytesRead)
                    pipeFos?.flush()
                    
                    // 在每次寫入 pipe 後嘗試創建並發送音頻塊
                    createAndEmitAudioChunk()
                } catch (e: Exception) {
                    Log.e(Constants.TAG, "Error writing to FFmpeg pipe", e)
                }

                // Emit audio data at defined intervals
                if (SystemClock.elapsedRealtime() - lastEmitTime >= interval) {
                    emitAudioData(
                        accumulatedAudioData.toByteArray(),
                        accumulatedAudioData.size()
                    )
                    lastEmitTime = SystemClock.elapsedRealtime() // Reset the timer
                    accumulatedAudioData.reset() // Clear the accumulator
                }

                Log.d(Constants.TAG, "Bytes read: $bytesRead")
            }
        }
    }

    private fun createAndEmitAudioChunk() {
        webmFile?.let { sourceFile ->
            if (!sourceFile.exists()) {
                Log.d(Constants.TAG, "WebM file does not exist, skipping chunk creation")
                return
            }
            
            val currentTime = SystemClock.elapsedRealtime()
            // 確保我們按照設定的時間間隔創建塊
            if (currentTime - lastChunkCreationTime < interval) {
                Log.d(Constants.TAG, "Not enough time elapsed for new chunk (${currentTime - lastChunkCreationTime}ms < ${interval}ms)")
                return // 尚未達到間隔時間
            }
            
            try {
                // 創建新的塊文件
                val chunkFileName = "chunk_${streamUuid}_${chunkCounter}.mp4"
                val chunkFile = File(filesDir, chunkFileName)
                
                // 複製當前的文件內容到塊文件
                sourceFile.copyTo(chunkFile, overwrite = true)
                
                // 更新最後創建的塊文件和時間
                lastChunkFile = chunkFile
                lastChunkCreationTime = currentTime
                
                Log.d(Constants.TAG, "Creating chunk ${chunkCounter}, sentChunkIndices: $sentChunkIndices")
                
                // 發送事件
                emitChunkUpdate(chunkFile, chunkCounter, false)
                
                // 記錄已發送的塊索引
                sentChunkIndices.add(chunkCounter)
                
                // 增加塊計數器
                chunkCounter++
            } catch (e: Exception) {
                Log.e(Constants.TAG, "Error creating audio chunk", e)
            }
        }
    }

    private fun processLastChunk() {
        if (webmFile != null && !sentFinalChunk) {
            // 使用當前的索引（而非chunkCounter-1）創建一個新的最終塊
            Log.d(Constants.TAG, "Creating a new final chunk with index $chunkCounter, existing sentChunkIndices: $sentChunkIndices")
            
            try {
                // 創建新的最終塊文件
                val finalChunkFileName = "chunk_${streamUuid}_${chunkCounter}.mp4"
                val finalChunkFile = File(filesDir, finalChunkFileName)
                
                // 複製當前的文件內容到最終塊文件
                webmFile?.copyTo(finalChunkFile, overwrite = true)
                
                // 保存最終塊文件信息
                finalChunkFileUri = finalChunkFile.toURI().toString()
                finalChunkIndex = chunkCounter
                
                // 發送標記為最終塊的事件
                mainHandler.post {
                    try {
                        eventSender.sendExpoEvent(
                            Constants.AUDIO_CHUNK_UPDATE_EVENT_NAME, bundleOf(
                                "chunkFileUri" to finalChunkFile.toURI().toString(),
                                "chunkIndex" to chunkCounter,
                                "streamUuid" to streamUuid,
                                "isLastChunk" to true
                            )
                        )
                        Log.d(Constants.TAG, "Created and marked NEW chunk $chunkCounter as final chunk")
                        sentFinalChunk = true
                        // 不要增加chunkCounter，因為我們已經停止錄音了
                    } catch (e: Exception) {
                        Log.e(Constants.TAG, "Failed to send final chunk update event", e)
                    }
                }
            } catch (e: Exception) {
                Log.e(Constants.TAG, "Error creating final audio chunk", e)
            }
        } else {
            Log.d(Constants.TAG, "Skipping processLastChunk as final chunk was already sent (sentFinalChunk: $sentFinalChunk) or no webm file created (webmFile: ${webmFile != null})")
        }
    }

    private fun emitChunkUpdate(chunkFile: File, chunkIndex: Int, isLastChunk: Boolean) {
        mainHandler.post {
            try {
                eventSender.sendExpoEvent(
                    Constants.AUDIO_CHUNK_UPDATE_EVENT_NAME, bundleOf(
                        "chunkFileUri" to chunkFile.toURI().toString(),
                        "chunkIndex" to chunkIndex,
                        "streamUuid" to streamUuid,
                        "isLastChunk" to isLastChunk
                    )
                )
                Log.d(Constants.TAG, "Emitted chunk update event for chunk $chunkIndex, isLastChunk: $isLastChunk, URI: ${chunkFile.toURI()}")
            } catch (e: Exception) {
                Log.e(Constants.TAG, "Failed to send chunk update event", e)
            }
        }
    }

    private fun emitAudioData(audioData: ByteArray, length: Int) {
        val encodedBuffer = audioDataEncoder.encodeToBase64(audioData)

        // Calculate position in milliseconds based on total data processed
        val byteRate = recordingConfig.sampleRate * recordingConfig.channels * when (recordingConfig.encoding) {
            "pcm_8bit" -> 1
            "pcm_16bit" -> 2
            "pcm_32bit" -> 4
            else -> 2
        }
        val positionInMs = if (byteRate > 0) (totalDataSize * 1000 / byteRate) else 0

        mainHandler.post {
            try {
                eventSender.sendExpoEvent(
                    Constants.AUDIO_EVENT_NAME, bundleOf(
                        "webmFileUri" to webmFile?.toURI().toString(),
                        "encoded" to encodedBuffer,
                        "deltaSize" to length,
                        "position" to positionInMs,
                        "mimeType" to mimeType,
                        "totalSize" to totalDataSize,
                        "streamUuid" to streamUuid
                    )
                )
            } catch (e: Exception) {
                Log.e(Constants.TAG, "Failed to send event", e)
            }
        }
    }

    private fun getCompressedAudioDuration(file: File?): Long {
        // Placeholder function for fetching duration from a compressed audio file
        // This would depend on how you store or can retrieve duration info for compressed formats
        return 0L // Implement this based on your specific requirements
    }
}