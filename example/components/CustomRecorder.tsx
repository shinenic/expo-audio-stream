import { Button, Platform, StyleSheet, Text, View } from "react-native";
import { ExpoPlayAudioStream } from "../../src";
import { useEffect, useRef, useState } from "react";
import { AudioDataEvent } from "../../src/types";
import { Subscription } from "expo-modules-core";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import { BehaviorSubject, filter, firstValueFrom } from "rxjs";

const ANDROID_SAMPLE_RATE = 48000;
const IOS_SAMPLE_RATE = 48000;
const CHANNELS = 2;
const ENCODING = "pcm_16bit";
const RECORDING_INTERVAL = 2 * 1000;

const API_SOURCE = "http://192.168.1.123:3000";

export default function CustomRecorder() {
  const eventListenerSubscriptionRef = useRef<Subscription | undefined>(
    undefined
  );
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [chunks, setChunks] = useState<Array<{ uri: string; index: number }>>(
    []
  );
  const [mergedAudioUrl, setMergedAudioUrl] = useState<string | null>(null);
  const chunkCountRef = useRef<number>(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState<number>(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const chunkUploadTaskManager = useRef<ChunkUploadTaskManager | null>(null);

  const onAudioCallback = async (audio: AudioDataEvent) => {
    console.log("on audio callback");
    if (audio.chunkFileUri) {
      const newChunk = {
        uri: audio.chunkFileUri,
        index: chunkCountRef.current++,
      };
      setChunks((prev) => [...prev, newChunk]);

      chunkUploadTaskManager.current?.addChunk(newChunk);
    }
  };

  const playEventsListenerSubscriptionRef = useRef<Subscription | undefined>(
    undefined
  );

  useEffect(() => {
    playEventsListenerSubscriptionRef.current =
      ExpoPlayAudioStream.subscribeToSoundChunkPlayed(async (event) => {
        console.log(event);
      });

    return () => {
      if (playEventsListenerSubscriptionRef.current) {
        playEventsListenerSubscriptionRef.current.remove();
        playEventsListenerSubscriptionRef.current = undefined;
      }
    };
  }, []);

  // Clean up sound object when component unmounts
  useEffect(() => {
    return () => {
      if (sound) {
        sound.unloadAsync();
      }
    };
  }, [sound]);

  // Add timer effect to track recording duration
  useEffect(() => {
    if (isRecording) {
      setRecordingDuration(0);
      timerRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isRecording]);

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  const playAudio = async (uri: string) => {
    try {
      if (!uri) {
        console.log("No audio URI provided");
        return;
      }

      // Unload any existing sound
      if (sound) {
        await sound.unloadAsync();
      }

      // Add a small delay before playing to ensure file is ready
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Create and play the new sound
      const { sound: newSound } = await Audio.Sound.createAsync({
        uri: uri,
      });
      setSound(newSound);
      await newSound.playAsync();
    } catch (error) {
      console.error("Failed to play audio", error);
    }
  };

  const startRecording = async () => {
    if (!(await requestMicrophonePermission())) {
      return;
    }

    try {
      chunkUploadTaskManager.current = new ChunkUploadTaskManager();
      setMergedAudioUrl(null);

      const sampleRate =
        Platform.OS === "ios" ? IOS_SAMPLE_RATE : ANDROID_SAMPLE_RATE;
      const { recordingResult, subscription } =
        await ExpoPlayAudioStream.startMicrophone({
          interval: RECORDING_INTERVAL,
          sampleRate,
          channels: CHANNELS,
          encoding: ENCODING,
          onAudioStream: onAudioCallback,
        });

      console.log(JSON.stringify(recordingResult, null, 2));
      eventListenerSubscriptionRef.current = subscription;
      setIsRecording(true);
      setChunks([]);
      setRecordingDuration(0);
    } catch (error) {
      console.error("Failed to start recording", error);
    }
  };

  const stopRecording = async () => {
    try {
      const start = performance.now();
      const recordingResult = await ExpoPlayAudioStream.stopMicrophone();
      const end = performance.now();
      console.log(`Stop recording time taken: ${end - start} milliseconds`);
      console.log(
        "Native recording result:",
        JSON.stringify(recordingResult, null, 2)
      );

      if (recordingResult?.fileUri) {
        setRecordingUri(recordingResult.fileUri);
      }

      if (eventListenerSubscriptionRef.current) {
        eventListenerSubscriptionRef.current.remove();
        eventListenerSubscriptionRef.current = undefined;
      }

      setIsRecording(false);

      const remoteUrl = await chunkUploadTaskManager.current?.complete();
      console.log({ remoteUrl });
    } catch (error) {
      console.error("Failed to stop recording", error);
    }
  };

  return (
    <View style={styles.recorderContainer}>
      <Text style={styles.title}>Audio Recording Demo</Text>

      <View style={styles.buttonGroup}>
        <Text style={styles.sectionTitle}>Recording Controls</Text>
        {isRecording && (
          <View style={styles.recordingStatus}>
            <View style={styles.recordingIndicator} />
            <Text style={styles.recordingText}>
              Recording: {formatDuration(recordingDuration)}
            </Text>
          </View>
        )}
        <Button
          onPress={startRecording}
          title="Start Recording"
          disabled={isRecording}
        />
        <Button
          onPress={stopRecording}
          title="Stop Recording"
          disabled={!isRecording}
        />
      </View>

      <View style={styles.buttonGroup}>
        {mergedAudioUrl && (
          <View style={styles.mergedAudio}>
            <Text style={styles.sectionTitle}>Merged Audio</Text>
            <Text>URL: {mergedAudioUrl}</Text>
            <Button
              onPress={() => playAudio(mergedAudioUrl)}
              title="Play Merged Audio"
            />
          </View>
        )}
      </View>

      <View style={styles.chunkList}>
        <Text style={styles.sectionTitle}>Audio Chunks ({chunks.length})</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 10,
    textAlign: "center",
  },
  buttonGroup: {
    width: "80%",
    marginBottom: 20,
    padding: 15,
    backgroundColor: "#f8f9fa",
    borderRadius: 10,
    alignItems: "center",
  },
  chunkList: {
    width: "80%",
    marginBottom: 20,
    padding: 15,
    backgroundColor: "#f8f9fa",
    borderRadius: 10,
  },
  recordingStatus: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
    padding: 8,
    backgroundColor: "rgba(255, 0, 0, 0.1)",
    borderRadius: 8,
  },
  recordingIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "red",
    marginRight: 8,
  },
  recordingText: {
    fontWeight: "500",
    color: "#d63031",
  },
  recorderContainer: {
    width: "100%",
    alignItems: "center",
  },
  uploadStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginVertical: 10,
  },
  mergedAudio: {
    marginTop: 10,
    padding: 10,
    backgroundColor: "#e3f2fd",
    borderRadius: 5,
  },
});

class ChunkUploadTaskManager {
  private queue$: BehaviorSubject<Array<{ uri: string; index: number }>> =
    new BehaviorSubject([] as Array<{ uri: string; index: number }>);
  private sessionId$: BehaviorSubject<string | null> = new BehaviorSubject(
    null as string | null
  );
  private processingJob = 0;
  private MAX_PROCESSING_JOB = 1;

  constructor() {
    // Start a new session
    fetch(`${API_SOURCE}/start`, {
      method: "POST",
    }).then(async (sessionResponse) => {
      if (!sessionResponse.ok) throw new Error("Failed to start session");

      const { sessionId: newSessionId } = await sessionResponse.json();
      this.sessionId$.next(newSessionId);
    });
  }

  addChunk(task: { uri: string; index: number }) {
    console.log("addChunk", task);
    this.queue$.next([...this.queue$.getValue(), task]);

    this.processQueue();
  }

  private async processQueue() {
    const sessionId = await firstValueFrom(
      this.sessionId$.pipe(filter((id) => id !== null))
    );

    const task = this.queue$.value[0];
    console.log("task", task);

    if (this.processingJob >= this.MAX_PROCESSING_JOB || !task) return;

    this.processingJob += 1;

    const uploadTask = FileSystem.createUploadTask(
      `${API_SOURCE}/upload-chunk?id=${sessionId}&index=${task.index}`,
      task.uri,
      {
        sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: "chunk",
        mimeType: "audio/wav",
        parameters: {
          id: sessionId,
          index: task.index.toString(),
        },
      }
    );

    try {
      await uploadTask.uploadAsync();
    } catch (e) {
      console.error("Failed to upload chunk:", e);

      // @TODO error retry
    }

    console.log("done");

    this.processingJob -= 1;
    this.queue$.next(this.queue$.getValue().slice(1));
    this.processQueue();
  }

  async complete() {
    const sessionId = await firstValueFrom(
      this.sessionId$.pipe(filter((id) => id !== null))
    );

    await firstValueFrom(this.queue$.pipe(filter((arr) => arr.length === 0)));

    const response = await fetch(`${API_SOURCE}/complete?id=${sessionId}`, {
      method: "POST",
    });
    console.log(response);
    if (!response.ok) throw new Error("Completion failed");

    const result = await response.json();
    return result.url as string;
  }
}

export const requestMicrophonePermission = async (): Promise<boolean> => {
  const { granted } = await Audio.getPermissionsAsync();
  let permissionGranted = granted;
  if (!permissionGranted) {
    const { granted: grantedPermission } =
      await Audio.requestPermissionsAsync();
    permissionGranted = grantedPermission;
  }
  return permissionGranted;
};
