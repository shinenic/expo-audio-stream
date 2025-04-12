import { Button, Platform, StyleSheet, Text, View } from "react-native";
import { ExpoPlayAudioStream } from "../../src";
import { useEffect, useRef, useState } from "react";
import { Subscription } from "expo-modules-core";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
// import { BehaviorSubject, filter, firstValueFrom } from "rxjs";
// import {
//   FFmpegKit,
//   FFmpegKitConfig,
//   ReturnCode,
// } from "ffmpeg-kit-react-native";
import * as Sharing from "expo-sharing";
import { Uploader } from "./uploader";
import { Buffer } from "buffer";

const ANDROID_SAMPLE_RATE = 48000;
const IOS_SAMPLE_RATE = 48000;
const CHANNELS = 2;
const ENCODING = "pcm_16bit";
const RECORDING_INTERVAL = 5 * 1000;

const concatFileBufferAndSaveToFile = async (
  fileUris: string[],
  targetFileUri: string
) => {
  // Read first file as binary
  let fileBuffer = await FileSystem.readAsStringAsync(fileUris[0], {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Convert base64 to binary
  let binaryData = Buffer.from(fileBuffer, "base64");

  // Concat remaining files as binary
  for (const fileUri of fileUris.slice(1)) {
    const nextBuffer = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const nextBinaryData = Buffer.from(nextBuffer, "base64");

    // @ts-expect-error todo
    binaryData = Buffer.concat([binaryData, nextBinaryData]);
  }

  // Write final binary back as base64
  await FileSystem.writeAsStringAsync(
    targetFileUri,
    binaryData.toString("base64"),
    {
      encoding: FileSystem.EncodingType.Base64,
    }
  );
};

export default function CustomRecorder() {
  const eventListenerSubscriptionRef = useRef<Subscription | undefined>(
    undefined
  );
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);

  const [mp4RecordingUri, setMp4RecordingUri] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState<number>(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const [concatFileUri, setConcatFileUri] = useState<string | null>(null);
  const [mp4Chunks, setMp4Chunks] = useState<string[]>([]);
  const uploader = useRef<Uploader | null>(null);

  // Clean up sound object when component unmounts
  useEffect(() => {
    return () => {
      if (sound) {
        sound.unloadAsync();
      }
      // cleanupFFmpegSession();
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

  const playAudio = async (uri: string) => {
    try {
      if (!uri) {
        alert("No audio URI provided");
        return;
      }

      if (sound) {
        await sound.unloadAsync();
      }

      const { sound: newSound } = await Audio.Sound.createAsync({
        uri,
      });
      setSound(newSound);
      await newSound.playAsync();
    } catch (error) {
      console.error("Failed to play audio", error);
    }
  };

  const shareAudio = async (uri: string | null) => {
    if (!uri) {
      console.error("Cannot share: uri is null or undefined");
      return;
    }

    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (isAvailable) {
        // Ensure we have a shareable file by creating a copy in the cache directory if needed
        let shareableUri = uri;

        // If the file is not in a shareable location, make a copy
        if (!uri.startsWith(FileSystem.cacheDirectory!)) {
          const fileInfo = await FileSystem.getInfoAsync(uri);
          if (fileInfo.exists) {
            const fileExtension = uri.split(".").pop();
            const fileName = `share-audio-${Date.now()}.${fileExtension}`;
            const destinationUri = `${FileSystem.cacheDirectory}${fileName}`;

            await FileSystem.copyAsync({
              from: uri,
              to: destinationUri,
            });

            shareableUri = destinationUri;
          }
        }

        // Set appropriate UTI (Uniform Type Identifier) for iOS
        // const shareOptions = {
        //   mimeType: uri.endsWith(".webm") ? "audio/webm" : "audio/x-wav",
        //   UTI: uri.endsWith(".webm") ? "public.webm-audio" : "public.audio",
        //   dialogTitle: "Share audio file",
        // };

        await Sharing.shareAsync(
          shareableUri
          // shareOptions
        );
      } else {
        alert("Sharing is not available on this device");
      }
    } catch (error: any) {
      console.error("Error sharing audio file:", error);
      alert("Failed to share file: " + (error.message || "Unknown error"));
    }
  };

  const startRecording = async () => {
    if (!(await requestMicrophonePermission())) {
      return;
    }

    try {
      uploader.current = new Uploader();

      const sampleRate =
        Platform.OS === "ios" ? IOS_SAMPLE_RATE : ANDROID_SAMPLE_RATE;
      // Start microphone recording
      const { recordingResult, subscription } =
        await ExpoPlayAudioStream.startMicrophone({
          interval: RECORDING_INTERVAL,
          sampleRate,
          channels: CHANNELS,
          encoding: ENCODING,
          onAudioChunkUpdate: async (event) => {
            console.log(
              "onAudioChunkUpdate callback invoked, index: ",
              event.chunkIndex,
              "isLastChunk:",
              event.isLastChunk,
              "length:",
              event.length
            );

            setMp4Chunks((prev) => [...prev, event.chunkFileUri]);

            if (uploader.current) {
              uploader.current.addChunk({
                uri: event.chunkFileUri,
                index: event.chunkIndex,
              });

              if (event.isLastChunk) {
                uploader.current.done();
              }
            }
          },
        });

      if (recordingResult.mp4FileUri) {
        setMp4RecordingUri(recordingResult.mp4FileUri);
      }

      console.log(JSON.stringify(recordingResult, null, 2));
      eventListenerSubscriptionRef.current = subscription;
      setIsRecording(true);
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
        <Button
          onPress={async () => {
            const fileUri = `${
              FileSystem.cacheDirectory
            }/concat-${Date.now()}.mp4`;
            await concatFileBufferAndSaveToFile(mp4Chunks, fileUri);
            setConcatFileUri(fileUri);
          }}
          title="Concatenate and Save"
          disabled={isRecording}
        />
        <Button
          title="Share"
          disabled={!concatFileUri}
          onPress={async () => {
            if (!concatFileUri) {
              return;
            }

            let shareableUri = concatFileUri;

            if (!concatFileUri.startsWith(FileSystem.cacheDirectory!)) {
              const fileInfo = await FileSystem.getInfoAsync(concatFileUri);
              if (fileInfo.exists) {
                const fileName = concatFileUri.split("/").pop();
                const destinationUri = `${FileSystem.cacheDirectory}${fileName}`;

                await FileSystem.copyAsync({
                  from: concatFileUri,
                  to: destinationUri,
                });

                shareableUri = destinationUri;
              }
            }

            await Sharing.shareAsync(shareableUri);
          }}
        />
      </View>

      <View style={styles.buttonGroup}>
        {recordingUri && (
          <View style={styles.mergedAudio}>
            <Text style={styles.sectionTitle}>Recording Audio</Text>
            <Text>URL: {recordingUri}</Text>
            <View style={styles.buttonRow}>
              <Button
                onPress={() => playAudio(recordingUri)}
                title="Play recording Audio"
              />
              <Button onPress={() => shareAudio(recordingUri)} title="Share" />
            </View>
          </View>
        )}
      </View>

      <View style={styles.buttonGroup}>
        {mp4RecordingUri && (
          <View style={styles.mergedAudio}>
            <Text style={styles.sectionTitle}>MP4 Audio</Text>
            <Text>URL: {mp4RecordingUri}</Text>
            <View style={styles.buttonRow}>
              <Button
                onPress={() => playAudio(mp4RecordingUri)}
                title="Play MP4 Audio"
              />
              <Button
                onPress={() => shareAudio(mp4RecordingUri)}
                title="Share"
              />
            </View>
          </View>
        )}
      </View>

      <View style={styles.chunkList}>
        <Text style={styles.sectionTitle}>MP4 Chunks ({mp4Chunks.length})</Text>
        {mp4Chunks.map((chunk, index) => (
          <View
            key={chunk}
            style={{ display: "flex", flexDirection: "row", gap: 20 }}
          >
            <Text>chunk {index}</Text>
            <Button
              title="Share"
              onPress={async () => {
                let shareableUri = chunk;

                if (!chunk.startsWith(FileSystem.cacheDirectory!)) {
                  const fileInfo = await FileSystem.getInfoAsync(chunk);
                  if (fileInfo.exists) {
                    const fileExtension = chunk.split(".").pop();
                    const fileName = `share-audio-${Date.now()}.${fileExtension}`;
                    const destinationUri = `${FileSystem.cacheDirectory}${fileName}`;

                    await FileSystem.copyAsync({
                      from: chunk,
                      to: destinationUri,
                    });

                    shareableUri = destinationUri;
                  }
                }

                await Sharing.shareAsync(shareableUri);
              }}
            />
          </View>
        ))}
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
  buttonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
  },
  audioUrl: {
    fontSize: 12,
    color: "#6c757d",
  },
});

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

const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}`;
};
