import { Button, Platform, StyleSheet, Text, View } from "react-native";
import { ExpoPlayAudioStream } from "../../src";
import { useEffect, useRef, useState } from "react";
import { AudioDataEvent } from "../../src/types";
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

const ANDROID_SAMPLE_RATE = 48000;
const IOS_SAMPLE_RATE = 48000;
const CHANNELS = 2;
const ENCODING = "pcm_16bit";
const RECORDING_INTERVAL = 3 * 1000;

export default function CustomRecorder() {
  const eventListenerSubscriptionRef = useRef<Subscription | undefined>(
    undefined
  );
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);

  const [webMRecordingUri, setWebMRecordingUri] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState<number>(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const ffmpegSessionRef = useRef<any>(null);
  const pipePathRef = useRef<string | null>(null);
  const outputFileRef = useRef<string | null>(null);
  const tempChunkCounter = useRef<number>(0);
  const [chunks, setChunks] = useState<
    { position: number; fileUri: string; size: number }[]
  >([]);

  const onAudioCallback = async (audio: AudioDataEvent) => {
    console.log("on audio callback");

    // try {
    //   console.log(`pipePathRef.current`, pipePathRef.current);
    //   if (pipePathRef.current) {
    //     const pcmData = audio.data as string;

    //     // If audio.data is a Base64 string, we need to create a temporary buffer file
    //     // This approach creates only one temporary file per callback instead of multiple
    //     const tempFilePath = `${
    //       FileSystem.cacheDirectory
    //     }temp_pcm_buffer-${new Date().getTime()}.pcm`;

    //     // Write the PCM data to the temp file
    //     await FileSystem.writeAsStringAsync(tempFilePath, pcmData, {
    //       encoding: FileSystem.EncodingType.Base64,
    //     });

    //     setChunks((prev) => [
    //       ...prev,
    //       {
    //         position: audio.position,
    //         fileUri: tempFilePath,
    //         size: audio.eventDataSize,
    //       },
    //     ]);

    //     // Write the file to the pipe and wait for it to complete
    //     const result = await FFmpegKitConfig.writeToPipe(
    //       tempFilePath,
    //       pipePathRef.current
    //     );
    //     console.log(`writeToPipe result`, result);

    //     // Clean up the temporary file
    //     // await FileSystem.deleteAsync(tempFilePath, { idempotent: true });
    //   }
    // } catch (error) {
    //   console.error("Error writing to FFmpeg pipe:", error);
    // }
  };

  // // Clean up function for FFmpeg session
  // const cleanupFFmpegSession = async () => {
  //   try {
  //     if (ffmpegSessionRef.current) {
  //       // Cancel any ongoing FFmpeg session if needed
  //       const sessionId = await ffmpegSessionRef.current.getSessionId();
  //       if (sessionId) {
  //         await FFmpegKit.cancel(sessionId);
  //       }
  //       ffmpegSessionRef.current = null;
  //     }

  //     // Clear pipe reference
  //     pipePathRef.current = null;
  //   } catch (error) {
  //     console.error("Error cleaning up FFmpeg session:", error);
  //   }
  // };

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
            const fileExtension = uri.endsWith(".webm") ? "webm" : "wav";
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
      // // Clean up any existing session
      // await cleanupFFmpegSession();

      // // Reset temp chunk counter
      // tempChunkCounter.current = 0;

      // // Create output file path for the webm file
      // const outputFile = `${
      //   FileSystem.documentDirectory
      // }recording_${Date.now()}.webm`;
      // outputFileRef.current = outputFile;

      // // Register a new FFmpeg pipe
      // const pipeName = await FFmpegKitConfig.registerNewFFmpegPipe();
      // pipePathRef.current = pipeName;

      // console.log("Registered pipe:", pipeName);

      // Build the FFmpeg command for converting PCM to WebM (Opus)
      const sampleRate =
        Platform.OS === "ios" ? IOS_SAMPLE_RATE : ANDROID_SAMPLE_RATE;

      // // FFmpeg command that reads from pipe and outputs to WebM with Opus codec
      // const ffmpegCommand = `-f s16le -ar ${sampleRate} -ac ${CHANNELS} -i ${pipeName} -c:a libopus -b:a 128k ${outputFile}`;

      // console.log("Starting FFmpeg with command:", ffmpegCommand);

      // // Start FFmpeg in the background
      // FFmpegKit.executeAsync(ffmpegCommand, async (session) => {
      //   const returnCode = await session.getReturnCode();
      //   ffmpegSessionRef.current = null;

      //   if (ReturnCode.isSuccess(returnCode)) {
      //     console.log(`Successfully encoded audio to WebM: ${outputFile}`);
      //     setWebMRecordingUri(outputFile);
      //   } else {
      //     console.error(
      //       `FFmpeg operation failed with return code: ${returnCode}`
      //     );
      //     const output = await session.getOutput();
      //     console.error("FFmpeg output:", output);
      //   }
      // }).then((session) => {
      //   ffmpegSessionRef.current = session;

      //   setInterval(() => {
      //     FileSystem.getInfoAsync(outputFile).then((res) => {
      //       console.log(res.exists ? res.size : "not found");
      //     });
      //   }, 2000);
      // });

      // Start microphone recording
      const { recordingResult, subscription } =
        await ExpoPlayAudioStream.startMicrophone({
          interval: RECORDING_INTERVAL,
          sampleRate,
          channels: CHANNELS,
          encoding: ENCODING,
          onAudioStream: onAudioCallback,
        });

      console.log(recordingResult.webmFileUri);
      if (recordingResult.webmFileUri) {
        setWebMRecordingUri(recordingResult.webmFileUri);

        setInterval(() => {
          FileSystem.getInfoAsync(recordingResult.webmFileUri || "").then(
            (res) => {
              console.log(res.exists ? res.size : "not found");
            }
          );
        }, 2000);
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

      // Close the pipe to signal end of input to FFmpeg
      // if (pipePathRef.current) {
      //   await FFmpegKitConfig.closeFFmpegPipe(pipePathRef.current);
      //   pipePathRef.current = null;
      // }

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
        {webMRecordingUri && (
          <View style={styles.mergedAudio}>
            <Text style={styles.sectionTitle}>WebM Audio</Text>
            <Text>URL: {webMRecordingUri}</Text>
            <View style={styles.buttonRow}>
              <Button
                onPress={() => playAudio(webMRecordingUri)}
                title="Play WebM Audio"
              />
              <Button
                onPress={() => shareAudio(webMRecordingUri)}
                title="Share"
              />
            </View>
          </View>
        )}
      </View>

      <View style={styles.chunkList}>
        <Text style={styles.sectionTitle}>Audio Chunks ({chunks.length})</Text>
        {chunks.map((chunk) => (
          <View
            key={chunk.fileUri}
            style={{ display: "flex", flexDirection: "row", gap: 20 }}
          >
            <Text>{chunk.position}</Text>
            <Text>{chunk.size}</Text>
            <Button
              title="Share"
              onPress={async () => {
                let shareableUri = chunk.fileUri;

                if (!chunk.fileUri.startsWith(FileSystem.cacheDirectory!)) {
                  const fileInfo = await FileSystem.getInfoAsync(chunk.fileUri);
                  if (fileInfo.exists) {
                    const fileExtension = chunk.fileUri.split(".").pop();
                    const fileName = `share-audio-${Date.now()}.${fileExtension}`;
                    const destinationUri = `${FileSystem.cacheDirectory}${fileName}`;

                    await FileSystem.copyAsync({
                      from: chunk.fileUri,
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
