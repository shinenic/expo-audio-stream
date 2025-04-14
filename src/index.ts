import { Subscription } from "expo-modules-core";
import ExpoPlayAudioStreamModule from "./ExpoPlayAudioStreamModule";
import {
  AudioRecording,
  RecordingConfig,
  StartRecordingResult,
  Encoding,
  EncodingTypes,
} from "./types";

import {
  addAudioChunkUpdateListener,
  AudioChunkUpdateEventPayload,
  AudioEvents,
} from "./events";

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
    chunkSubscription?: Subscription;
  }> {
    let chunkSubscription: Subscription | undefined;

    try {
      const { onAudioChunkUpdate, ...options } = recordingConfig;

      if (onAudioChunkUpdate && typeof onAudioChunkUpdate == "function") {
        chunkSubscription = addAudioChunkUpdateListener(async (event) => {
          onAudioChunkUpdate(event);

          if (event.isLastChunk) {
            chunkSubscription?.remove();
          }
        });
      }

      const result = await ExpoPlayAudioStreamModule.startMicrophone(options);

      return { recordingResult: result, chunkSubscription };
    } catch (error) {
      console.error(error);
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
   * Prompts the user to select the microphone mode.
   * @returns {Promise<void>}
   * @throws {Error} If the microphone mode fails to prompt.
   *
   * @note iOS only
   */
  static promptMicrophoneModes() {
    return ExpoPlayAudioStreamModule.promptMicrophoneModes();
  }
}

export {
  AudioChunkUpdateEventPayload,
  AudioRecording,
  RecordingConfig,
  StartRecordingResult,
  AudioEvents,
  Encoding,
  EncodingTypes,
};
