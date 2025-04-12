// packages/expo-audio-stream/src/events.ts

import { EventEmitter, type Subscription } from "expo-modules-core";

import ExpoPlayAudioStreamModule from "./ExpoPlayAudioStreamModule";

const emitter = new EventEmitter(ExpoPlayAudioStreamModule);

export interface AudioChunkUpdateEventPayload {
  chunkFileUri: string;
  chunkIndex: number;
  streamUuid: string;
  isLastChunk: boolean;
  length: number;
}

export const AudioEvents = {
  AudioChunkUpdate: "AudioChunkUpdate",
};

export function addAudioChunkUpdateListener(
  listener: (event: AudioChunkUpdateEventPayload) => Promise<void>
): Subscription {
  const subscription = emitter.addListener<AudioChunkUpdateEventPayload>(
    AudioEvents.AudioChunkUpdate,
    async (event) => {
      await listener(event);
    }
  );
  return subscription;
}
