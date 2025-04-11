import { Subscription } from "expo-modules-core";
import ExpoPlayAudioStreamModule from "./ExpoPlayAudioStreamModule";
import {
  AudioDataEvent,
  AudioRecording,
  RecordingConfig,
  StartRecordingResult,
  SoundConfig,
  PlaybackMode,
  Encoding,
  EncodingTypes,
  PlaybackModes,
} from "./types";

import {
  addAudioEventListener,
  addSoundChunkPlayedListener,
  addAudioChunkUpdateListener,
  AudioEventPayload,
  AudioChunkUpdateEventPayload,
  SoundChunkPlayedEventPayload,
  AudioEvents,
  subscribeToEvent,
  DeviceReconnectedReason,
  DeviceReconnectedEventPayload,
} from "./events";

const SuspendSoundEventTurnId = "suspend-sound-events";

export class ExpoPlayAudioStream {
  /**
   * Destroys the audio stream module, cleaning up all resources.
   * This should be called when the module is no longer needed.
   * It will reset all internal state and release audio resources.
   */
  static destroy() {
    ExpoPlayAudioStreamModule.destroy();
  }

  /**
   * Starts microphone streaming.
   * @param {RecordingConfig} recordingConfig - The recording configuration.
   * @returns {Promise<{recordingResult: StartRecordingResult, subscription: Subscription}>} A promise that resolves to an object containing the recording result and a subscription to audio events.
   * @throws {Error} If the recording fails to start.
   */
  static async startMicrophone(recordingConfig: RecordingConfig): Promise<{
    recordingResult: StartRecordingResult;
    subscription?: Subscription;
    chunkSubscription?: Subscription;
  }> {
    let subscription: Subscription | undefined;
    let chunkSubscription: Subscription | undefined;

    try {
      const { onAudioStream, onAudioChunkUpdate, ...options } = recordingConfig;

      if (onAudioStream && typeof onAudioStream == "function") {
        subscription = addAudioEventListener(
          async (event: AudioEventPayload) => {
            const {
              fileUri,
              deltaSize,
              totalSize,
              position,
              encoded,
              soundLevel,
            } = event;
            if (!encoded) {
              console.error(
                `[ExpoPlayAudioStream] Encoded audio data is missing`
              );
              throw new Error("Encoded audio data is missing");
            }
            onAudioStream?.({
              data: encoded,
              position,
              fileUri,
              eventDataSize: deltaSize,
              totalSize,
              soundLevel,
            });
          }
        );
      }

      if (onAudioChunkUpdate && typeof onAudioChunkUpdate == "function") {
        chunkSubscription = addAudioChunkUpdateListener(
          async (event: AudioChunkUpdateEventPayload) => {
            const { chunkFileUri, chunkIndex, streamUuid, isLastChunk, length } = event;
            onAudioChunkUpdate?.({
              chunkFileUri,
              chunkIndex,
              streamUuid,
              isLastChunk,
              length,
            });
          }
        );
      }

      const result = await ExpoPlayAudioStreamModule.startMicrophone(options);

      return { recordingResult: result, subscription, chunkSubscription };
    } catch (error) {
      console.error(error);
      subscription?.remove();
      chunkSubscription?.remove();
      throw new Error(`Failed to start recording: ${error}`);
    }
  }

  /**
   * Stops the current microphone streaming.
   * @returns {Promise<void>}
   * @throws {Error} If the microphone streaming fails to stop.
   */
  static async stopMicrophone(): Promise<AudioRecording | null> {
    try {
      return await ExpoPlayAudioStreamModule.stopMicrophone();
    } catch (error) {
      console.error(error);
      throw new Error(`Failed to stop mic stream: ${error}`);
    }
  }

  /**
   * Subscribes to audio events emitted during recording/streaming.
   * @param onMicrophoneStream - Callback function that will be called when audio data is received.
   * The callback receives an AudioDataEvent containing:
   * - data: Base64 encoded audio data at original sample rate
   * - data16kHz: Optional base64 encoded audio data resampled to 16kHz
   * - position: Current position in the audio stream
   * - fileUri: URI of the recording file
   * - eventDataSize: Size of the current audio data chunk
   * - totalSize: Total size of recorded audio so far
   * @returns {Subscription} A subscription object that can be used to unsubscribe from the events
   * @throws {Error} If encoded audio data is missing from the event
   */
  static subscribeToAudioEvents(
    onMicrophoneStream: (event: AudioDataEvent) => Promise<void>
  ): Subscription {
    return addAudioEventListener(async (event: AudioEventPayload) => {
      const { fileUri, deltaSize, totalSize, position, encoded, soundLevel } =
        event;
      if (!encoded) {
        console.error(`[ExpoPlayAudioStream] Encoded audio data is missing`);
        throw new Error("Encoded audio data is missing");
      }
      onMicrophoneStream?.({
        data: encoded,
        position,
        fileUri,
        eventDataSize: deltaSize,
        totalSize,
        soundLevel,
      });
    });
  }

  /**
   * Subscribes to events emitted when a sound chunk has finished playing.
   * @param onSoundChunkPlayed - Callback function that will be called when a sound chunk is played.
   * The callback receives a SoundChunkPlayedEventPayload indicating if this was the final chunk.
   * @returns {Subscription} A subscription object that can be used to unsubscribe from the events.
   */
  static subscribeToSoundChunkPlayed(
    onSoundChunkPlayed: (event: SoundChunkPlayedEventPayload) => Promise<void>
  ): Subscription {
    return addSoundChunkPlayedListener(onSoundChunkPlayed);
  }

  /**
   * Subscribes to events emitted by the audio stream module, for advanced use cases.
   * @param eventName - The name of the event to subscribe to.
   * @param onEvent - Callback function that will be called when the event is emitted.
   * @returns {Subscription} A subscription object that can be used to unsubscribe from the events.
   */
  static subscribe<T extends unknown>(
    eventName: string,
    onEvent: (event: T | undefined) => Promise<void>
  ): Subscription {
    return subscribeToEvent(eventName, onEvent);
  }

  /**
   * Sets the sound player configuration.
   * @param {SoundConfig} config - Configuration options for the sound player.
   * @returns {Promise<void>}
   * @throws {Error} If the configuration fails to update.
   */
  static async setSoundConfig(config: SoundConfig): Promise<void> {
    try {
      await ExpoPlayAudioStreamModule.setSoundConfig(config);
    } catch (error) {
      console.error(error);
      throw new Error(`Failed to set sound configuration: ${error}`);
    }
  }

  /**
   * Prompts the user to select the microphone mode.
   * @returns {Promise<void>}
   * @throws {Error} If the microphone mode fails to prompt.
   */
  static promptMicrophoneModes() {
    ExpoPlayAudioStreamModule.promptMicrophoneModes();
  }

  /**
   * Subscribes to audio chunk update events during recording.
   * @param onAudioChunkUpdate - Callback function called when a new audio chunk is available
   * @returns {Subscription} A subscription object to remove the listener
   */
  static subscribeToAudioChunkUpdates(
    onAudioChunkUpdate: (event: AudioChunkUpdateEventPayload) => Promise<void>
  ): Subscription {
    const subscription = addAudioChunkUpdateListener(async (event) => {
      await onAudioChunkUpdate(event);
    });
    return subscription;
  }
}

export {
  AudioDataEvent,
  SoundChunkPlayedEventPayload,
  AudioChunkUpdateEventPayload,
  DeviceReconnectedReason,
  DeviceReconnectedEventPayload,
  AudioRecording,
  RecordingConfig,
  StartRecordingResult,
  AudioEvents,
  SuspendSoundEventTurnId,
  SoundConfig,
  PlaybackMode,
  Encoding,
  EncodingTypes,
  PlaybackModes,
};
