package expo.modules.audiostream

import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.os.Bundle
import android.util.Log
import androidx.annotation.RequiresApi
import expo.modules.interfaces.permissions.Permissions
import android.Manifest


class ExpoPlayAudioStreamModule : Module(), EventSender {
    private lateinit var audioRecorderManager: AudioRecorderManager

    @RequiresApi(Build.VERSION_CODES.R)
    override fun definition() = ModuleDefinition {
        Name("ExpoPlayAudioStream")

        Events(Constants.AUDIO_CHUNK_UPDATE_EVENT_NAME)

        // Initialize managers for playback and for recording
        initializeManager()

        OnCreate {
        }

        Function("destroy") {
            initializeManager()
        }

        AsyncFunction("requestPermissionsAsync") { promise: Promise ->
            Permissions.askForPermissionsWithPermissionsManager(
                appContext.permissions,
                promise,
                Manifest.permission.RECORD_AUDIO
            )
        }

        AsyncFunction("getPermissionsAsync") { promise: Promise ->
            Permissions.getPermissionsWithPermissionsManager(
                appContext.permissions,
                promise,
                Manifest.permission.RECORD_AUDIO
            )
        }

        AsyncFunction("startMicrophone") { options: Map<String, Any?>, promise: Promise ->
            audioRecorderManager.startRecording(options, promise)
        }

        AsyncFunction("stopMicrophone") { promise: Promise ->
            audioRecorderManager.stopRecording(promise)
        }
    }
    
    private fun initializeManager() {
        val androidContext = 
            appContext.reactContext ?: throw IllegalStateException("Android context not available")
        val permissionUtils = PermissionUtils(androidContext)
        audioRecorderManager = 
            AudioRecorderManager(androidContext.filesDir, permissionUtils, this, androidContext)
    }

    override fun sendExpoEvent(eventName: String, params: Bundle) {
        Log.d(Constants.TAG, "Sending event EXPO: $eventName")
        this@ExpoPlayAudioStreamModule.sendEvent(eventName, params)
    }
}
