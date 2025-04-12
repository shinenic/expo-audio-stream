package expo.modules.audiostream

import android.content.Context
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
import com.arthenica.ffmpegkit.SessionState
import expo.modules.kotlin.Promise
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean


class AudioRecorderManager(
    private val filesDir: File,
    private val permissionUtils: PermissionUtils,
    private val audioDataEncoder: AudioDataEncoder,
    private val eventSender: EventSender,
    private val context: Context
) {
    private var audioRecord: AudioRecord? = null
    private var bufferSizeInBytes = 0
    private var isRecording = AtomicBoolean(false)
    private val isPaused = AtomicBoolean(false)
    private var streamUuid: String? = null
    private var audioFile: File? = null
    private var recordingThread: Thread? = null
    private var recordingStartTime: Long = 0
    private var totalRecordedTime: Long = 0
    private var totalDataSize = 0
    private var interval = 1000L  // Emit data every 1000 milliseconds (1 second)
    private var lastEmitTime = SystemClock.elapsedRealtime()
    private var lastPauseTime = 0L
    private var pausedDuration = 0L
    private var lastProcessedSize = 0L
    private val mainHandler = Handler(Looper.getMainLooper())
    private val audioRecordLock = Any()
    private val sentChunkIndices = HashSet<Int>()
    
    // FFmpeg related properties
    private var ffmpegPipe: String? = null
    private var ffmpegPipeOutputStream: FileOutputStream? = null
    private var isFFmpegCompleted = false
    private var isPipeClosed = false
    private var audioChunkCounter = 0
    private var lastAudioChunkSize = 0L
    private var mp4File: File? = null
    
    // File monitoring related properties
    private var fileObserverThread: Thread? = null
    private var fileObserverRunning = AtomicBoolean(false)

    private lateinit var recordingConfig: RecordingConfig
    private var mimeType = "audio/mp4"
    private var audioFormat: Int = AudioFormat.ENCODING_PCM_16BIT

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

        // Set encoding format
        audioFormat = when (tempRecordingConfig.encoding) {
            "pcm_8bit" -> AudioFormat.ENCODING_PCM_8BIT
            "pcm_16bit" -> AudioFormat.ENCODING_PCM_16BIT
            "pcm_32bit", "pcm_float" -> AudioFormat.ENCODING_PCM_FLOAT
            else -> AudioFormat.ENCODING_PCM_16BIT
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

        // Recalculate bufferSizeInBytes for the format
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

        // Setup FFmpeg for MP4 encoding
        try {
            streamUuid = UUID.randomUUID().toString()
            val mp4FileName = "audio_${streamUuid}.mp4"
            mp4File = File(filesDir, mp4FileName)
            
            // Reset all states
            sentChunkIndices.clear()
            audioChunkCounter = 0
            lastAudioChunkSize = 0
            isPipeClosed = false
            isFFmpegCompleted = false
            
            // Create empty file
            mp4File?.createNewFile()
            
            // Register FFmpeg pipe
            ffmpegPipe = FFmpegKitConfig.registerNewFFmpegPipe(context)
            if (ffmpegPipe == null) {
                promise.reject("FFMPEG_PIPE_FAILED", "Failed to create FFmpeg pipe", null)
                return
            }
            
            // Determine PCM format
            val format = when (tempRecordingConfig.encoding) {
                "pcm_8bit" -> "u8"
                "pcm_32bit", "pcm_float" -> "f32le"
                else -> "s16le" // Default to 16-bit
            }
            
            // Build FFmpeg command
            val ffmpegCommand = "-f $format -ar ${recordingConfig.sampleRate} -ac ${recordingConfig.channels} " +
                    "-i $ffmpegPipe -c:a aac -b:a 192k -flush_packets 1 -max_delay 0 -fflags nobuffer " +
                    "-flags low_delay -f mp4 -movflags frag_keyframe+empty_moov+faststart -frag_duration 1000000 " +
                    "-y ${mp4File?.absolutePath}"
            
            Log.d(Constants.TAG, "FFmpeg command: $ffmpegCommand")
            
            // Execute FFmpeg in async mode
            FFmpegKit.executeAsync(ffmpegCommand, { session ->
                Log.d(Constants.TAG, "FFmpeg session completed")
                isFFmpegCompleted = true
                
                // Get session state and return code
                val state = session?.state ?: SessionState.FAILED
                val returnCode = session?.returnCode
                
                // if (returnCode != null && ReturnCode.isSuccess(returnCode)) {
                //     Log.d(Constants.TAG, "FFmpeg process completed successfully with return code: ${returnCode.value}")
                // } else if (state == SessionState.CANCELLED || session?.output?.contains("Exiting normally") == true) {
                //     Log.d(Constants.TAG, "FFmpeg process cancelled normally")
                // } else {
                //     Log.e(Constants.TAG, "FFmpeg process failed: ${session?.failStackTrace ?: "Unknown error"}")
                // }
                
                // If file observer is still running, create one final chunk
                // @TODO check
                if (fileObserverRunning.get()) {
                    mainHandler.post {
                        createAndEmitAudioChunk()
                    }
                }
            }, { log ->
                val message = log?.message ?: ""
                // Filter out verbose stats logs
                if (!message.contains("frame=") && !message.contains("fps=")) {
                    Log.d(Constants.TAG, "FFmpeg log: $message")
                }
            }, null)
            
            // Open pipe for writing
            ffmpegPipeOutputStream = FileOutputStream(ffmpegPipe)
            
            // Start file monitoring
            startFileMonitoring()
            
        } catch (e: Exception) {
            promise.reject("FFMPEG_SETUP_FAILED", "Failed to setup FFmpeg processing", e)
            return
        }

        // Start recording
        audioRecord?.startRecording()
        isPaused.set(false)
        isRecording.set(true)

        if (!isPaused.get()) {
            recordingStartTime = System.currentTimeMillis() // Only reset start time if it's not a resume
        }

        recordingThread = Thread { recordingProcess() }.apply { start() }

        val result = bundleOf(
            "fileUri" to "",
            "mp4FileUri" to mp4File?.toURI().toString(),
            "channels" to recordingConfig.channels,
            "bitDepth" to when (recordingConfig.encoding) {
                "pcm_8bit" -> 8
                "pcm_16bit" -> 16
                "pcm_32bit", "pcm_float" -> 32
                else -> 16 // Default to 16 if the encoding is not recognized
            },
            "sampleRate" to recordingConfig.sampleRate,
            "mimeType" to mimeType
        )
        promise.resolve(result)
    }

    // @TODO debounce the file written callback
    // @TODO a more reliable way to monitor the file?
    private fun startFileMonitoring() {
        fileObserverRunning.set(true)
        fileObserverThread = Thread {
            var lastModified = mp4File?.lastModified() ?: 0
            var lastSize = mp4File?.length() ?: 0
            
            while (fileObserverRunning.get() && !Thread.currentThread().isInterrupted) {
                try {
                    // Check file modification time and size
                    val newModified = mp4File?.lastModified() ?: 0
                    val newSize = mp4File?.length() ?: 0
                    
                    if (newModified > lastModified || newSize > lastSize) {
                        lastModified = newModified
                        lastSize = newSize
                        
                        // Trigger chunk creation on main thread
                        mainHandler.post {
                            createAndEmitAudioChunk()
                        }
                    }
                    
                    // Avoid excessive CPU usage
                    Thread.sleep(300)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                } catch (e: Exception) {
                    Log.e(Constants.TAG, "Error in file monitoring", e)
                }
            }
            Log.d(Constants.TAG, "File monitoring stopped")
        }.apply { start() }
    }

    private fun createAndEmitAudioChunk() {
        if (mp4File == null || !mp4File!!.exists()) {
            Log.d(Constants.TAG, "MP4 file does not exist, skipping chunk creation")
            return
        }

        try {
            // Get current file size
            val fileSize = mp4File!!.length()
            
            // Skip if file size hasn't increased and it's not the last chunk
            if (fileSize <= lastAudioChunkSize && !isFFmpegCompleted) {
                Log.d(Constants.TAG, "File size not increased (current: $fileSize, last: $lastAudioChunkSize), skipping")
                return
            }
            
            // Create new chunk file
            val chunkFileName = "chunk_${streamUuid}_${audioChunkCounter}.mp4"
            val chunkFile = File(filesDir, chunkFileName)
            
            // Read new data from the original file
            val startOffset = lastAudioChunkSize
            val length = fileSize - startOffset
            
            if (length > 0) {
                // Copy the incremental data to new chunk file
                val randomAccessFile = RandomAccessFile(mp4File, "r")
                randomAccessFile.seek(startOffset)
                
                val buffer = ByteArray(length.toInt())
                randomAccessFile.read(buffer)
                randomAccessFile.close()
                
                FileOutputStream(chunkFile).use { fos ->
                    fos.write(buffer)
                }
                
                // Update last processed size
                lastAudioChunkSize = fileSize
                
                // Emit chunk update event
                emitChunkUpdate(chunkFile.toURI().toString(), audioChunkCounter, isFFmpegCompleted, length)
                
                // Record this chunk as sent
                sentChunkIndices.add(audioChunkCounter)
                audioChunkCounter++
                
                Log.d(Constants.TAG, "Created and emitted chunk ${audioChunkCounter-1} with size ${length} bytes, isLastChunk: $isFFmpegCompleted")
            }
            
            // If this is the last chunk, stop file monitoring
            if (isFFmpegCompleted) {
                stopFileMonitoring()
            }
        } catch (e: Exception) {
            Log.e(Constants.TAG, "Error creating audio chunk", e)
            
            // If error occurs during final chunk handling, ensure monitoring stops
            if (isFFmpegCompleted) {
                stopFileMonitoring()
            }
        }
    }

    private fun stopFileMonitoring() {
        fileObserverRunning.set(false)
        fileObserverThread?.interrupt()
        fileObserverThread = null
        Log.d(Constants.TAG, "File monitoring stopped after final chunk")
    }

    private fun emitChunkUpdate(chunkFileUri: String, chunkIndex: Int, isLastChunk: Boolean, length: Long) {
        mainHandler.post {
            Log.d(Constants.TAG, "Emitting chunk update for chunk $chunkIndex, isLastChunk: $isLastChunk, length: $length")
            
            // Send the event
            eventSender.sendExpoEvent(
                Constants.AUDIO_CHUNK_UPDATE_EVENT_NAME,
                bundleOf(
                    "chunkFileUri" to chunkFileUri,
                    "chunkIndex" to chunkIndex,
                    "streamUuid" to streamUuid,
                    "isLastChunk" to isLastChunk,
                    "length" to length
                )
            )
        }
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

            // Process any final audio data
            try {
                val audioData = ByteArray(bufferSizeInBytes)
                val bytesRead = audioRecord?.read(audioData, 0, bufferSizeInBytes) ?: -1
                Log.d(Constants.TAG, "Last Read $bytesRead bytes")
                if (bytesRead > 0) {
                    emitAudioData(audioData, bytesRead)
                    
                    // Write final data to FFmpeg pipe
                    ffmpegPipeOutputStream?.write(audioData, 0, bytesRead)
                    ffmpegPipeOutputStream?.flush()
                }
                
                // Close FFmpeg pipe
                closeFfmpegPipe()

                Log.d(Constants.TAG, "Stopping recording state = ${audioRecord?.state}")
                if (audioRecord != null && audioRecord!!.state == AudioRecord.STATE_INITIALIZED) {
                    Log.d(Constants.TAG, "Stopping AudioRecord")
                    audioRecord!!.stop()
                }
            } catch (e: IllegalStateException) {
                Log.e(Constants.TAG, "Error reading from AudioRecord", e)
            } finally {
                audioRecord?.release()
                audioRecord = null
            }

            try {
                val fileSize = mp4File?.length() ?: 0
                
                // Create result bundle
                val result = bundleOf(
                    "fileUri" to "",
                    "mp4FileUri" to mp4File?.toURI().toString(),
                    "filename" to mp4File?.name,
                    "durationMs" to 0L, // Duration calculation would need to be implemented
                    "channels" to recordingConfig.channels,
                    "bitDepth" to when (recordingConfig.encoding) {
                        "pcm_8bit" -> 8
                        "pcm_16bit" -> 16
                        "pcm_32bit", "pcm_float" -> 32
                        else -> 16
                    },
                    "sampleRate" to recordingConfig.sampleRate,
                    "size" to fileSize,
                    "mimeType" to mimeType
                )
                promise.resolve(result)

                // Reset recording state
                isRecording.set(false)
                isPaused.set(false)
                totalRecordedTime = 0
                pausedDuration = 0
            } catch (e: Exception) {
                Log.d(Constants.TAG, "Failed to stop recording", e)
                promise.reject("STOP_FAILED", "Failed to stop recording", e)
            }
        }
    }

    private fun closeFfmpegPipe() {
        // Mark pipe as closed
        isPipeClosed = true
        Log.d(Constants.TAG, "Marking FFmpeg pipe as closed")
        
        // Ensure all data is written and close pipe
        try {
            ffmpegPipeOutputStream?.flush()
            ffmpegPipeOutputStream?.close()
            ffmpegPipeOutputStream = null
            
            if (ffmpegPipe != null) {
                FFmpegKitConfig.closeFFmpegPipe(ffmpegPipe)
                ffmpegPipe = null
                Log.d(Constants.TAG, "FFmpeg pipe closed")
            }
        } catch (e: Exception) {
            Log.e(Constants.TAG, "Error closing FFmpeg pipe", e)
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
                    "mimeType" to mimeType,
                    "size" to 0,
                    "interval" to interval,
                )
            }

            val fileSize = mp4File?.length() ?: 0
            
            // Note: Duration calculation for MP4 would require parsing the file
            // This is a placeholder for actual implementation
            val duration = 0L
            
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
        val fileList = filesDir.list()?.filter { it.endsWith(".mp4") || it.endsWith(".wav") }
            ?.map { File(filesDir, it).absolutePath } ?: listOf()
        promise.resolve(fileList)
    }

    fun clearAudioStorage(promise: Promise) {
        val files = filesDir.listFiles()
        var count = 0
        
        files?.forEach { file ->
            if (file.name.endsWith(".mp4") || file.name.endsWith(".wav") || file.name.startsWith("chunk_")) {
                if (file.delete()) {
                    count++
                }
            }
        }
        
        Log.d(Constants.TAG, "Deleted $count audio files")
        promise.resolve(count)
    }

    private fun recordingProcess() {
        Log.i(Constants.TAG, "Starting recording process...")
        
        // Buffer to accumulate data
        val accumulatedAudioData = ByteArrayOutputStream()
        
        // Recording loop
        val audioData = ByteArray(bufferSizeInBytes)
        Log.d(Constants.TAG, "Entering recording loop")
        
        while (isRecording.get() && !Thread.currentThread().isInterrupted) {
            if (isPaused.get()) {
                // If recording is paused, skip reading
                continue
            }

            val bytesRead = synchronized(audioRecordLock) {
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
                } ?: -1
            }
            
            if (bytesRead > 0) {
                totalDataSize += bytesRead
                accumulatedAudioData.write(audioData, 0, bytesRead)

                // Emit audio data at defined intervals or if recording is stopped
                val currentTime = SystemClock.elapsedRealtime()
                val intervalElapsed = currentTime - lastEmitTime >= interval
                
                if (intervalElapsed || !isRecording.get()) {
                    // Copy accumulated data
                    val dataToProcess = accumulatedAudioData.toByteArray()
                    
                    // Emit audio data to listener
                    emitAudioData(dataToProcess, dataToProcess.size)
                    
                    // Write to FFmpeg pipe
                    ffmpegPipeOutputStream?.write(dataToProcess)
                    
                    // Reset timer and accumulator
                    lastEmitTime = currentTime
                    accumulatedAudioData.reset()
                    
                    Log.d(Constants.TAG, "Wrote ${dataToProcess.size} bytes to FFmpeg pipe")
                }
            }
        }
        
        Log.d(Constants.TAG, "Exiting recording loop")
    }

    private fun emitAudioData(audioData: ByteArray, length: Int) {
        val encodedBuffer = audioDataEncoder.encodeToBase64(audioData)

        val fileSize = mp4File?.length() ?: 0
        val from = lastProcessedSize
        val deltaSize = length.toLong()
        lastProcessedSize = totalDataSize.toLong()

        // Calculate position (approximate)
        val positionInMs = (from * 1000) / (recordingConfig.sampleRate * recordingConfig.channels * (if (recordingConfig.encoding == "pcm_8bit") 1 else 2))

        mainHandler.post {
            try {
                eventSender.sendExpoEvent(
                    Constants.AUDIO_EVENT_NAME, bundleOf(
                        "fileUri" to mp4File?.toURI().toString(),
                        "lastEmittedSize" to from,
                        "encoded" to encodedBuffer,
                        "deltaSize" to deltaSize,
                        "position" to positionInMs,
                        "mimeType" to mimeType,
                        "totalSize" to fileSize,
                        "streamUuid" to streamUuid
                    )
                )
            } catch (e: Exception) {
                Log.e(Constants.TAG, "Failed to send event", e)
            }
        }
    }
}