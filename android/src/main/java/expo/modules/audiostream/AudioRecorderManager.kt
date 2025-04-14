package expo.modules.audiostream

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.os.bundleOf
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFmpegKitConfig
import com.arthenica.ffmpegkit.ReturnCode
import com.arthenica.ffmpegkit.Session
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
    private val eventSender: EventSender,
    private val context: Context
) {
    private var audioRecord: AudioRecord? = null
    private var bufferSizeInBytes = 0
    private var isRecording = AtomicBoolean(false)
    private var streamUuid: String? = null
    private var totalRecordedTime: Long = 0
    private var lastEmitTime = SystemClock.elapsedRealtime()
    private var pausedDuration = 0L
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
    private var fileObserver: CustomFileObserver? = null
    private var fileObserverRunning = AtomicBoolean(false)
    private val debounceHandler = Handler(Looper.getMainLooper())
    private var pendingFileChangeRunnable: Runnable? = null
    private val DEBOUNCE_DELAY = 300L

    private lateinit var recordingConfig: RecordingConfig
    private var mimeType = "audio/mp4"
    private var audioFormat: Int = AudioFormat.ENCODING_PCM_16BIT

    // @TODO verify and remove this annotation
    @RequiresApi(Build.VERSION_CODES.R)
    fun startRecording(options: Map<String, Any?>, promise: Promise) {
        if (!permissionUtils.checkRecordingPermission()) {
            promise.reject("PERMISSION_DENIED", "Recording permission has not been granted", null)
            return
        }

        if (isRecording.get()) {
            promise.reject("ALREADY_RECORDING", "Recording is already in progress", null)
            return
        }

        // Initialize the recording configuration
        var tempRecordingConfig = RecordingConfig(
            sampleRate = (options["sampleRate"] as? Number)?.toInt() ?: Constants.DEFAULT_SAMPLE_RATE,
            channels = (options["channels"] as? Number)?.toInt() ?: 1,
            encoding = options["encoding"] as? String ?: "pcm_16bit",
            interval = (options["interval"] as? Number)?.toLong() ?: Constants.DEFAULT_INTERVAL,
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
        if (audioRecord == null) {
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

            mp4File?.createNewFile()

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
            FFmpegKit.executeAsync(ffmpegCommand, { session ->
                isFFmpegCompleted = true
            }, null, null)
            
            ffmpegPipeOutputStream = FileOutputStream(ffmpegPipe)
            startFileMonitoring()
            
        } catch (e: Exception) {
            promise.reject("FFMPEG_SETUP_FAILED", "Failed to setup FFmpeg processing", e)
            return
        }

        // Start recording
        audioRecord?.startRecording()
        isRecording.set(true)

        Thread { recordingProcess() }.apply { start() }

        val result = bundleOf(
            "mp4FileUri" to mp4File?.toURI().toString(),
            "channels" to recordingConfig.channels,
            "bitDepth" to when (recordingConfig.encoding) {
                "pcm_8bit" -> 8
                "pcm_16bit" -> 16
                "pcm_32bit", "pcm_float" -> 32
                else -> 16 // Default to 16 if the encoding is not recognized
            },
            "sampleRate" to recordingConfig.sampleRate,
            "mimeType" to mimeType,
            "streamUuid" to streamUuid
        )
        promise.resolve(result)
    }

    private fun startFileMonitoring() {
        fileObserverRunning.set(true)
        
        // Create a file observer to monitor the MP4 file
        mp4File?.let { file ->
            fileObserver = CustomFileObserver(file.absolutePath).apply {
                startWatching()
                Log.d(Constants.TAG, "File observer started for ${file.name}")
            }
        } ?: run {
            Log.e(Constants.TAG, "Cannot start file monitoring - MP4 file is null")
        }
    }

    /**
     * Custom FileObserver that monitors changes to the MP4 file.
     */
    private inner class CustomFileObserver(path: String) : FileObserver(path, MODIFY or CLOSE_WRITE) {
        override fun onEvent(event: Int, path: String?) {
            if (!fileObserverRunning.get()) return
            
            when (event) {
                MODIFY, CLOSE_WRITE -> {
                    // Debounce file changes to avoid excessive processing
                    debounceFileChange()
                }
            }
        }
    }
    
    private fun debounceFileChange() {
        pendingFileChangeRunnable?.let {
            debounceHandler.removeCallbacks(it)
        }
        
        pendingFileChangeRunnable = Runnable {
            mainHandler.post {
                createAndEmitAudioChunk()
            }
        }.also {
            debounceHandler.postDelayed(it, DEBOUNCE_DELAY)
        }
    }

    /**
     * Creates and emits an audio chunk from the current MP4 file.
     * Handles incremental data and checks for the last chunk.
     */
    private fun createAndEmitAudioChunk() {
        if (mp4File == null || !mp4File!!.exists()) {
            Log.d(Constants.TAG, "MP4 file does not exist, skipping chunk creation")
            return
        }

        try {
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
            
            if (length > 0 || isFFmpegCompleted) {
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
                
                Log.d(Constants.TAG, "Created and emitted chunk ${audioChunkCounter-1} with size ${length} bytes, isLastChunk: ${isFFmpegCompleted && isPipeClosed}")
                
                // If this is the last chunk, stop file monitoring
                if (isFFmpegCompleted) {
                    stopFileMonitoring()
                }
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
        if (!fileObserverRunning.get()) return
        
        fileObserverRunning.set(false)
        
        pendingFileChangeRunnable?.let {
            debounceHandler.removeCallbacks(it)
        }
        
        fileObserver?.stopWatching()
        fileObserver = null
    }

    private fun emitChunkUpdate(chunkFileUri: String, chunkIndex: Int, isLastChunk: Boolean, length: Long) {
        mainHandler.post {
            Log.d(Constants.TAG, "Emitting chunk update for chunk $chunkIndex, isLastChunk: $isLastChunk, length: $length")
            
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
                if (audioRecord != null && audioRecord!!.state == AudioRecord.STATE_INITIALIZED) {
                    audioRecord!!.stop()
                }
                isRecording.set(false)
                
                val audioData = ByteArray(bufferSizeInBytes)
                val bytesRead = audioRecord?.read(audioData, 0, bufferSizeInBytes) ?: -1
                if (bytesRead > 0) {
                    // Write final data to FFmpeg pipe
                    ffmpegPipeOutputStream?.write(audioData, 0, bytesRead)
                    ffmpegPipeOutputStream?.flush()
                }
                
                // Close FFmpeg pipe - this will trigger the final processing
                closeFfmpegPipe()
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
        
        // Ensure all data is written and close pipe
        try {
            ffmpegPipeOutputStream?.flush()
            ffmpegPipeOutputStream?.close()
            ffmpegPipeOutputStream = null
            
            if (ffmpegPipe != null) {
                FFmpegKitConfig.closeFFmpegPipe(ffmpegPipe)
                ffmpegPipe = null
            }
        } catch (e: Exception) {
            Log.e(Constants.TAG, "Error closing FFmpeg pipe", e)
        }
    }

    private fun recordingProcess() {
        Log.i(Constants.TAG, "Starting recording process...")
        
        // Buffer to accumulate data
        val accumulatedAudioData = ByteArrayOutputStream()
        
        // Recording loop
        val audioData = ByteArray(bufferSizeInBytes)
        Log.d(Constants.TAG, "Entering recording loop")
        
        while (isRecording.get() && !Thread.currentThread().isInterrupted) {
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
                accumulatedAudioData.write(audioData, 0, bytesRead)

                // Emit audio data at defined intervals or if recording is stopped
                val currentTime = SystemClock.elapsedRealtime()
                val intervalElapsed = currentTime - lastEmitTime >= recordingConfig.interval
                
                if (intervalElapsed || !isRecording.get()) {
                    // Copy accumulated data
                    val dataToProcess = accumulatedAudioData.toByteArray()
                    
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
}