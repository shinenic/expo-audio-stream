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
import java.util.concurrent.atomic.AtomicBoolean


class AudioRecorderManager(
    private val filesDir: File,
    private val permissionUtils: PermissionUtils,
    private val audioDataEncoder: AudioDataEncoder,
    private val eventSender: EventSender
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
    private var lastEmittedSize = 0L
    private val mainHandler = Handler(Looper.getMainLooper())
    private val audioRecordLock = Any()
    private var audioFileHandler: AudioFileHandler = AudioFileHandler(filesDir)
    
    // Track WebM chunk files for later concatenation
    private val webmChunkFiles = mutableListOf<File>()
    private var chunkCounter = 0
    private var isFirstChunk = true

    private lateinit var recordingConfig: RecordingConfig
    private var mimeType = "audio/wav"
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

        // Reset the chunk tracking variables
        webmChunkFiles.clear()
        chunkCounter = 0
        isFirstChunk = true

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
        var fileExtension = ".wav"
        audioFormat = when (tempRecordingConfig.encoding) {
            "pcm_8bit" -> {
                fileExtension = "wav"
                mimeType = "audio/wav"
                AudioFormat.ENCODING_PCM_8BIT
            }
            "pcm_16bit" -> {
                fileExtension = "wav"
                mimeType = "audio/wav"
                AudioFormat.ENCODING_PCM_16BIT
            }
            "pcm_32bit" -> {
                fileExtension = "wav"
                mimeType = "audio/wav"
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
                fileExtension = "opus"
                mimeType = "audio/opus"
                AudioFormat.ENCODING_OPUS
            }
            "aac_lc" -> {
                fileExtension = "aac"
                mimeType = "audio/aac"
                AudioFormat.ENCODING_AAC_LC
            }
            else -> {
                fileExtension = "wav"
                mimeType = "audio/wav"
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
        audioFile = File(filesDir, "audio_${streamUuid}.${fileExtension}")

        try {
            FileOutputStream(audioFile, true).use { fos ->
                audioFileHandler.writeWavHeader(fos, recordingConfig.sampleRate, recordingConfig.channels, when (recordingConfig.encoding) {
                    "pcm_8bit" -> 8
                    "pcm_16bit" -> 16
                    "pcm_32bit" -> 32
                    else -> 16 // Default to 16 if the encoding is not recognized
                })
            }
        } catch (e: IOException) {
            promise.reject("FILE_CREATION_FAILED", "Failed to create the audio file", e)
            return
        }

        audioRecord?.startRecording()
        isPaused.set(false)
        isRecording.set(true)

        if (!isPaused.get()) {
            recordingStartTime =
                System.currentTimeMillis() // Only reset start time if it's not a resume
        }

        recordingThread = Thread { recordingProcess() }.apply { start() }

        val result = bundleOf(
            "fileUri" to audioFile?.toURI().toString(),
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
                }

                Log.d(Constants.TAG, "Stopping recording state = ${audioRecord?.state}")
                if (audioRecord != null && audioRecord!!.state == AudioRecord.STATE_INITIALIZED) {
                    Log.d(Constants.TAG, "Stopping AudioRecord");
                    audioRecord!!.stop()
                }
            } catch (e: IllegalStateException) {
                Log.e(Constants.TAG, "Error reading from AudioRecord", e);
            } finally {
                audioRecord?.release()
            }

            try {
                val fileSize = audioFile?.length() ?: 0
                val dataFileSize = fileSize - 44  // Subtract header size
                val byteRate = recordingConfig.sampleRate * recordingConfig.channels * when (recordingConfig.encoding) {
                    "pcm_8bit" -> 1
                    "pcm_16bit" -> 2
                    "pcm_32bit" -> 4
                    else -> 2 // Default to 2 bytes per sample if the encoding is not recognized
                }
                // Calculate duration based on the data size and byte rate
                val duration = if (byteRate > 0) (dataFileSize * 1000 / byteRate) else 0

                // Create result bundle
                val result = bundleOf(
                    "fileUri" to audioFile?.toURI().toString(),
                    "filename" to audioFile?.name,
                    "durationMs" to duration,
                    "channels" to recordingConfig.channels,
                    "bitDepth" to when (recordingConfig.encoding) {
                        "pcm_8bit" -> 8
                        "pcm_16bit" -> 16
                        "pcm_32bit" -> 32
                        else -> 16 // Default to 16 if the encoding is not recognized
                    },
                    "sampleRate" to recordingConfig.sampleRate,
                    "size" to fileSize,
                    "mimeType" to mimeType
                )
                
                if (webmChunkFiles.isNotEmpty()) {
                    
                    val concatOutputFile = File(filesDir, "concat_${streamUuid}.webm")
                    val filterComplex = StringBuilder()
                    val inputArgs = StringBuilder()
                    for (i in webmChunkFiles.indices) {
                        inputArgs.append("-i ${webmChunkFiles[i].absolutePath} ")
                        filterComplex.append("[$i:a]")
                    }
                    
                    filterComplex.append("concat=n=${webmChunkFiles.size}:v=0:a=1[aout]")
                    
                    val concatCommand = inputArgs.toString() +
                            "-filter_complex \"${filterComplex}\" " +
                            "-map \"[aout]\" " +
                            "-c:a libopus " +
                            "-b:a 128k " + 
                            "-application audio " + // Audio application mode for highest quality
                            "-avoid_negative_ts make_zero " + // Handle timestamp issues
                            "-fflags +bitexact " + // Ensure exact bit-for-bit output
                            "${concatOutputFile.absolutePath}"
                    
                    val concatSession = FFmpegKit.execute(concatCommand)
                    
                    if (ReturnCode.isSuccess(concatSession.returnCode)) {
                        // Get metadata for the concatenated file
                        var concatDuration = 0L
                        val concatSize = concatOutputFile.length()
                        
                        // Get duration using FFmpeg
                        val durationCommand = "-i ${concatOutputFile.absolutePath} -show_entries format=duration -v quiet -of csv=\"p=0\""
                        FFmpegKit.execute(durationCommand).also { durationSession ->
                            if (ReturnCode.isSuccess(durationSession.returnCode)) {
                                val durationStr = durationSession.output
                                try {
                                    concatDuration = (durationStr.toFloat() * 1000).toLong()
                                } catch (e: Exception) {
                                    Log.e(Constants.TAG, "Failed to parse concat duration: $durationStr", e)
                                }
                            }
                        }
                        
                        // Add concatenated file info to the result
                        val resultWithConcat = result.apply {
                            putString("concatFileUri", concatOutputFile.toURI().toString())
                            putString("concatFilename", concatOutputFile.name)
                            putLong("concatDurationMs", concatDuration)
                            putLong("concatSize", concatSize)
                            putString("concatMimeType", "audio/webm")
                        }
                        
                        promise.resolve(resultWithConcat)
                    } else {
                        promise.resolve(result)
                    }
                } else {
                    promise.resolve(result)
                }

                // Reset the timing variables
                isRecording.set(false)
                isPaused.set(false)
                totalRecordedTime = 0
                pausedDuration = 0
                webmChunkFiles.clear()
                chunkCounter = 0
                isFirstChunk = true
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

            // Ensure you update this to check if audioFile is null or not
            val fileSize = audioFile?.length() ?: 0

            val duration = when (mimeType) {
                "audio/wav" -> {
                    val dataFileSize = fileSize - Constants.WAV_HEADER_SIZE // Assuming header is always 44 bytes
                    val byteRate = recordingConfig.sampleRate * recordingConfig.channels * (if (recordingConfig.encoding == "pcm_8bit") 8 else 16) / 8
                    if (byteRate > 0) dataFileSize * 1000 / byteRate else 0
                }
                "audio/opus", "audio/aac" -> getCompressedAudioDuration(audioFile)
                else -> 0
            }
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
        FileOutputStream(audioFile, true).use { fos ->
            // Buffer to accumulate data
            val accumulatedAudioData = ByteArrayOutputStream()
            audioFileHandler.writeWavHeader(
                accumulatedAudioData,
                recordingConfig.sampleRate,
                recordingConfig.channels,
                when (recordingConfig.encoding) {
                    "pcm_8bit" -> 8
                    "pcm_16bit" -> 16
                    "pcm_32bit" -> 32
                    else -> 16 // Default to 16 if the encoding is not recognized
                }
            )
            // Write audio data directly to the file
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
                    fos.write(audioData, 0, bytesRead)
                    totalDataSize += bytesRead
                    accumulatedAudioData.write(audioData, 0, bytesRead)

                    // Emit audio data at defined intervals
                    if (SystemClock.elapsedRealtime() - lastEmitTime >= interval) {
                        emitAudioData(
                            accumulatedAudioData.toByteArray(),
                            accumulatedAudioData.size()
                        )
                        lastEmitTime = SystemClock.elapsedRealtime() // Reset the timer
                        accumulatedAudioData.reset() // Clear the accumulator
                    }

                    Log.d(Constants.TAG, "Bytes written to file: $bytesRead")
                }
            }
        }
        // Update the WAV header to reflect the actual data size
        audioFile?.let { file ->
            audioFileHandler.updateWavHeader(file)
        }
    }

    private fun emitAudioData(audioData: ByteArray, length: Int) {
        val fileSize = audioFile?.length() ?: 0
        val from = lastEmittedSize
        val deltaSize = fileSize - lastEmittedSize
        lastEmittedSize = fileSize

        // Calculate position in milliseconds
        val positionInMs = (from * 1000) / (recordingConfig.sampleRate * recordingConfig.channels * (if (recordingConfig.encoding == "pcm_8bit") 8 else 16) / 8)
        
        // Create temporary PCM file for this chunk
        val tempPcmFile = File(filesDir, "temp_chunk_${streamUuid}_${chunkCounter}.pcm")
        try {
            FileOutputStream(tempPcmFile).use { fos ->
                fos.write(audioData, 0, length)
            }
            
            val webmChunkFile = File(filesDir, "chunk_${streamUuid}_${chunkCounter}.webm")
            chunkCounter++
            
            val bitrate = "128k"
            val compressionLevel = "10"
            
            // Convert PCM to WebM (Opus)
            val ffmpegCommand = "-f " + 
                    when (recordingConfig.encoding) {
                        "pcm_8bit" -> "u8"
                        "pcm_16bit" -> "s16le"
                        "pcm_32bit" -> "f32le"
                        else -> "s16le"
                    } + 
                    " -ar ${recordingConfig.sampleRate} " +
                    "-ac ${recordingConfig.channels} " +
                    "-i ${tempPcmFile.absolutePath} " +
                    "-c:a libopus " +
                    "-b:a $bitrate " +
                    "-compression_level $compressionLevel " +
                    "-application audio " + // "audio" mode is optimized for high quality audio
                    "-vbr off " + // Use constant bitrate for more consistent chunks
                    "-frame_duration 20 " + // 20ms frame size is optimal for Opus
                    "-mapping_family 1 " + // Ensure consistent mapping
                    "-strict experimental " + // Allow experimental encoders
                    "-fflags +bitexact " + // Ensure exact bit-for-bit output
                    webmChunkFile.absolutePath
            
            FFmpegKit.executeAsync(ffmpegCommand, { session ->
                if (ReturnCode.isSuccess(session.returnCode)) {
                    Log.d(Constants.TAG, "Successfully converted chunk to WebM")
                    
                    val durationCommand = "-i ${webmChunkFile.absolutePath} -show_entries format=duration -v quiet -of csv=\"p=0\""
                    FFmpegKit.execute(durationCommand).also { durationSession ->
                        var chunkDuration = 0L
                        if (ReturnCode.isSuccess(durationSession.returnCode)) {
                            val durationStr = durationSession.output
                            try {
                                chunkDuration = (durationStr.toFloat() * 1000).toLong()
                            } catch (e: Exception) {
                                Log.e(Constants.TAG, "Failed to parse duration: $durationStr", e)
                                chunkDuration = 0L
                            }
                        }
                        
                        // Keep reference to this file for sending to client
                        // but only add to concatenation list if it's not the first chunk
                        val isFirstChunkLocal = isFirstChunk
                        if (!isFirstChunkLocal) {
                            webmChunkFiles.add(webmChunkFile)
                            Log.d(Constants.TAG, "Added chunk to concatenation list")
                        } else {
                            Log.d(Constants.TAG, "Skipping first chunk for concatenation (contains initialization noise)")
                            isFirstChunk = false
                        }
                        
                        mainHandler.post {
                            try {
                                eventSender.sendExpoEvent(
                                    Constants.AUDIO_EVENT_NAME, bundleOf(
                                        "fileUri" to audioFile?.toURI().toString(),
                                        "lastEmittedSize" to from,
                                        "deltaSize" to length,
                                        "position" to positionInMs,
                                        "mimeType" to mimeType,
                                        "totalSize" to fileSize,
                                        "streamUuid" to streamUuid,
                                        "chunkFileUri" to webmChunkFile.toURI().toString(),
                                        "chunkFileSize" to webmChunkFile.length(),
                                        "chunkDuration" to chunkDuration,
                                        "isFirstChunk" to isFirstChunkLocal
                                    )
                                )
                            } catch (e: Exception) {
                                Log.e(Constants.TAG, "Failed to send event", e)
                            }
                        }
                    }
                } else {
                    Log.e(Constants.TAG, "FFmpeg failed to convert chunk to WebM: ${session.returnCode}")
                    
                    mainHandler.post {
                        try {
                            val encodedBuffer = audioDataEncoder.encodeToBase64(audioData)
                            eventSender.sendExpoEvent(
                                Constants.AUDIO_EVENT_NAME, bundleOf(
                                    "fileUri" to audioFile?.toURI().toString(),
                                    "lastEmittedSize" to from,
                                    "deltaSize" to length,
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
                
                // Delete the temporary PCM file
                tempPcmFile.delete()
            }, null, null)
            
        } catch (e: IOException) {
            Log.e(Constants.TAG, "Failed to create temporary PCM file", e)
            
            // Fall back to the original behavior if we can't convert to WebM
            val encodedBuffer = audioDataEncoder.encodeToBase64(audioData)
            mainHandler.post {
                try {
                    eventSender.sendExpoEvent(
                        Constants.AUDIO_EVENT_NAME, bundleOf(
                            "fileUri" to audioFile?.toURI().toString(),
                            "lastEmittedSize" to from,
                            "encoded" to encodedBuffer,
                            "deltaSize" to length,
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
            
            // Clean up
            tempPcmFile.delete()
        }
    }

    private fun getCompressedAudioDuration(file: File?): Long {
        // Placeholder function for fetching duration from a compressed audio file
        // This would depend on how you store or can retrieve duration info for compressed formats
        return 0L // Implement this based on your specific requirements
    }
}