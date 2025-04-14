import * as FileSystem from "expo-file-system";
import { BehaviorSubject, filter, firstValueFrom } from "rxjs";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AudioChunkUpdateEventPayload, ExpoPlayAudioStream } from "../../src";
import { Audio } from "expo-av";

const getAudioDuration = async (fileUri: string) => {
  try {
    const { sound } = await Audio.Sound.createAsync(
      { uri: fileUri },
      { shouldPlay: false }
    );

    const status = await sound.getStatusAsync();

    const durationMillis = status.isLoaded ? status.durationMillis : 0;

    // Unload the sound when done
    sound.unloadAsync();

    return (durationMillis || 0) / 1000;
  } catch (error) {
    console.error("Error loading audio:", error);
  }
};

// const API =
// "https://4e2c-2401-e180-8841-111b-94bb-e599-605a-9e45.ngrok-free.app";
// const API = "http://192.168.1.123:3000";
const API = "http://localhost:3000";

export class RecordingChunkUploadManager {}

/**
 * This class satisfies the following requirements from API:
 * - chunk files should be uploaded in order
 * - only one file can be uploaded at a time
 *
 * @TODO handle offline & reconnect
 * @TODO handle background? (minor)
 * @TODO handle restart app
 */
export class RecorderManager {
  private streamUuid$ = new BehaviorSubject<string | null>(null);
  private chunks$ = new BehaviorSubject<AudioChunkUpdateEventPayload[]>([]);
  private statusMap$ = new BehaviorSubject<{
    [index: number]: "pending" | "uploading" | "failed" | "uploaded";
  }>({});
  private lastUploadedChunkIndex = -1;

  public recordingStartTimestamp$ = new BehaviorSubject<number | null>(null);
  public isRecording$ = new BehaviorSubject<boolean>(false);
  public mp4FileUri$ = new BehaviorSubject<string | null>(null);

  constructor() {}

  public async start() {
    // cleanups
    this.isRecording$.next(false);
    this.recordingStartTimestamp$.next(null);
    this.mp4FileUri$.next(null);
    this.streamUuid$.next(null);

    try {
      const { recordingResult } = await ExpoPlayAudioStream.startMicrophone({
        // @TODO more reasonable interval
        interval: 5 * 1000,
        sampleRate: 48000,
        channels: 2,
        encoding: "pcm_16bit",
        onAudioChunkUpdate: async (event) => {
          console.log("onAudioChunkUpdate callback invoked, ", event);

          // @TODO store chunk info in async storage
          this.addChunk(event);
        },
      });

      // @TODO a more accurate way to get the start timestamp
      this.recordingStartTimestamp$.next(Date.now());
      this.isRecording$.next(true);
      this.mp4FileUri$.next(recordingResult.mp4FileUri || null);
      this.streamUuid$.next(recordingResult.streamUuid || null);
    } catch {
      this.isRecording$.next(false);
    }
  }

  public async stop() {
    this.isRecording$.next(false);

    try {
      await ExpoPlayAudioStream.stopMicrophone();

      const mp4File = await FileSystem.getInfoAsync(
        this.mp4FileUri$.value || ""
      );
      if (!mp4File.exists) throw new Error("The recording file does not exist");

      const fileSize = mp4File.size;
      const fileUri = mp4File.uri;
      const duration = await getAudioDuration(fileUri);
      // @TODO wait until the last chunk is created

      await firstValueFrom(
        this.chunks$.pipe(filter((c) => c.some((chunk) => chunk.isLastChunk)))
      );

      return {
        fileSize,
        fileUri,
      };
    } catch (error) {
      console.error("Failed to stop recording", error);
    }
  }

  public addChunk(chunk: AudioChunkUpdateEventPayload) {
    // this.chunks.push(chunk);
    // this.statusMap$.next({
    //   ...this.statusMap$.value,
    //   [chunk.index]: "pending",
    // });
    // this.doTask();
  }

  public async done() {
    const id = await firstValueFrom(
      this.sessionId$.pipe(filter((v) => typeof v === "string"))
    );

    console.log("Waiting for all chunks to be uploaded");
    await firstValueFrom(
      this.statusMap$.pipe(
        filter((v) => {
          return Object.values(v).every((status) => status === "uploaded");
        })
      )
    );
    console.log("All chunks uploaded");

    this.chunks = [];
    this.statusMap$.next({});

    const res = await fetch(`${API}/complete?id=${id}`, {
      method: "POST",
    });

    return res.json();
  }

  /**
   * @TODO delete the chunk file
   */
  private async doTask() {
    const sessionId = await firstValueFrom(
      this.sessionId$.pipe(filter((v) => typeof v === "string"))
    );

    const chunk = this.chunks.shift();

    if (!chunk) {
      return;
    }

    this.statusMap$.next({
      ...this.statusMap$.value,
      [chunk.index]: "uploading",
    });

    const uploadOptions = {
      fieldName: "chunk",
      headers: { "Content-Type": "multipart/form-data" },
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
    } satisfies FileSystem.FileSystemUploadOptions;

    const task = FileSystem.createUploadTask(
      `${API}/upload-chunk?id=${sessionId}&index=${chunk.index}`,
      chunk.uri,
      uploadOptions
    );

    const response = await task.uploadAsync();

    if (response?.status !== 200) {
      this.statusMap$.next({
        ...this.statusMap$.value,
        [chunk.index]: "failed",
      });
      throw new Error("Upload failed");
    }

    this.statusMap$.next({
      ...this.statusMap$.value,
      [chunk.index]: "uploaded",
    });

    return true;
  }

  /**
   * @TODO on destroy (is it necessary?)
   */
  // public async destroy() {
  //   ExpoPlayAudioStream.destroy();
  // }
}
