import { AudioChunkUpdateEventPayload } from "./events";

export type RecordingEncodingType = "pcm_32bit" | "pcm_16bit" | "pcm_8bit";
export type SampleRate = 16000 | 44100 | 48000;
export type BitDepth = 8 | 16 | 32;

export const EncodingTypes = {
  PCM_F32LE: "pcm_f32le",
  PCM_S16LE: "pcm_s16le",
} as const;

export type Encoding = (typeof EncodingTypes)[keyof typeof EncodingTypes];

export interface StartRecordingResult {
  mp4FileUri?: string;
  mimeType: string;
  channels?: number;
  bitDepth?: BitDepth;
  sampleRate?: SampleRate;
  streamUuid?: string;
}

export interface RecordingConfig {
  sampleRate?: SampleRate;
  channels?: 1 | 2;
  encoding?: RecordingEncodingType;
  interval?: number;
  onAudioChunkUpdate?: (event: AudioChunkUpdateEventPayload) => Promise<void>;
}

export interface AudioRecording {
  mp4FileUri?: string;
  filename: string;
  durationMs: number;
  size: number;
  channels: number;
  bitDepth: BitDepth;
  sampleRate: SampleRate;
  mimeType: string;
}
