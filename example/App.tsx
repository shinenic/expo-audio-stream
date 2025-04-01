import {
  Button,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  FlatList,
  ActivityIndicator,
} from "react-native";
import { ExpoPlayAudioStream } from "@mykin-ai/expo-audio-stream";
import { useEffect, useRef, useState } from "react";
import { AudioDataEvent } from "@mykin-ai/expo-audio-stream/types";
import { Subscription } from "expo-modules-core";
import { Audio } from "expo-av";
import Slider from "@react-native-community/slider";
import { v4 as uuidv4 } from "uuid";
import * as FileSystem from "expo-file-system";

const ANDROID_SAMPLE_RATE = 16000;
const IOS_SAMPLE_RATE = 48000;
const CHANNELS = 1;
const ENCODING = "pcm_16bit";
const RECORDING_INTERVAL = 2 * 1000;

const colors = ["#ff6b6b", "#48dbfb", "#1dd1a1", "#feca57", "#ff9ff3"] as const;

export default function App() {
  const [sliderValue, setSliderValue] = useState<number>(50);
  const [textValue, setTextValue] = useState<string>("");
  const [counter, setCounter] = useState<number>(0);
  const [colorIndex, setColorIndex] = useState<number>(0);

  return (
    <ScrollView contentContainerStyle={styles.recorderContainer}>
      <Text style={styles.title}>Audio Recording Demo</Text>

      <View style={styles.interactiveSection}>
        <Text style={styles.sectionTitle}>Interactive UI Elements</Text>

        <Text>Slider Value: {sliderValue.toFixed(1)}</Text>
        <Slider
          style={styles.slider}
          minimumValue={0}
          maximumValue={100}
          value={sliderValue}
          onValueChange={setSliderValue}
          minimumTrackTintColor="#007AFF"
          maximumTrackTintColor="#000000"
        />

        <TextInput
          style={styles.textInput}
          placeholder="Type something while recording..."
          value={textValue}
          onChangeText={setTextValue}
        />

        <View style={styles.counterContainer}>
          <TouchableOpacity
            style={styles.counterButton}
            onPress={() => setCounter((prev) => prev - 1)}
          >
            <Text style={styles.buttonText}>-</Text>
          </TouchableOpacity>
          <Text style={styles.counterText}>{counter}</Text>
          <TouchableOpacity
            style={styles.counterButton}
            onPress={() => setCounter((prev) => prev + 1)}
          >
            <Text style={styles.buttonText}>+</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.colorButton, { backgroundColor: colors[colorIndex] }]}
          onPress={() => setColorIndex((colorIndex + 1) % colors.length)}
        >
          <Text style={styles.colorButtonText}>Tap to change color</Text>
        </TouchableOpacity>
      </View>

      <Recorder />
      <ExpoAVRecorder />
    </ScrollView>
  );
}

function Recorder() {
  const eventListenerSubscriptionRef = useRef<Subscription | undefined>(
    undefined
  );
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [concatUri, setConcatUri] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [chunks, setChunks] = useState<
    Array<{ uri: string; isFirst: boolean }>
  >([]);
  const [currentChunk, setCurrentChunk] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState<number>(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const onAudioCallback = async (audio: AudioDataEvent) => {
    if (audio.chunkFileUri) {
      setChunks((prev) => [
        ...prev,
        {
          uri: audio.chunkFileUri as string,
          isFirst: audio.isFirstChunk || false,
        },
      ]);

      setCurrentChunk(audio.chunkFileUri);
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

    const sampleRate =
      Platform.OS === "ios" ? IOS_SAMPLE_RATE : ANDROID_SAMPLE_RATE;

    try {
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
      setConcatUri(null);
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

      if (recordingResult?.concatFileUri) {
        setConcatUri(recordingResult.concatFileUri);
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

  const playRecording = () => playAudio(recordingUri || "");
  const playConcat = () => playAudio(concatUri || "");

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
        <Text style={styles.sectionTitle}>Playback Controls</Text>
        <Button
          onPress={playRecording}
          title="Play WAV Recording (Local)"
          disabled={!recordingUri}
        />
        <Button
          onPress={playConcat}
          title="Play WebM Concat (Local)"
          disabled={!concatUri}
        />
      </View>

      <View style={styles.chunkList}>
        <Text style={styles.sectionTitle}>
          WebM Chunks ({chunks.length})
          {chunks.length > 0 && chunks[0].isFirst && (
            <Text style={styles.note}>
              {" "}
              (Note: First chunk may contain noise)
            </Text>
          )}
        </Text>
      </View>
    </View>
  );
}

function ExpoAVRecorder() {
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState<number>(0);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

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

  // Clean up sound object when component unmounts
  useEffect(() => {
    return () => {
      if (sound) {
        sound.unloadAsync();
      }
      if (recording) {
        recording.stopAndUnloadAsync();
      }
    };
  }, [sound, recording]);

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  const startRecording = async () => {
    if (!(await requestMicrophonePermission())) {
      return;
    }

    try {
      // Configure the recording
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      console.log("Starting expo-av recording...");
      const start = performance.now();

      // Create and start the recording
      const { recording: newRecording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      setRecording(newRecording);
      setIsRecording(true);
      setRecordingUri(null);
      const end = performance.now();
      console.log(`Expo-AV recording start time: ${end - start} milliseconds`);
    } catch (error) {
      console.error("Failed to start expo-av recording", error);
    }
  };

  const stopRecording = async () => {
    if (!recording) return;

    try {
      const start = performance.now();

      // Stop the recording
      await recording.stopAndUnloadAsync();

      // Get the URI of the recording
      const uri = recording.getURI();
      setRecordingUri(uri);

      // Reset the recording state
      setRecording(null);
      setIsRecording(false);

      // Reset audio mode
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
      });

      const end = performance.now();
      console.log(`Expo-AV recording save time: ${end - start} milliseconds`);
      console.log("Recording saved to:", uri);
    } catch (error) {
      console.error("Failed to stop expo-av recording", error);
    }
  };

  const playRecording = async () => {
    try {
      if (!recordingUri) {
        console.log("No audio URI provided");
        return;
      }

      // Unload any existing sound
      if (sound) {
        await sound.unloadAsync();
      }

      // Create and play the new sound
      const { sound: newSound } = await Audio.Sound.createAsync({
        uri: recordingUri,
      });
      setSound(newSound);
      await newSound.playAsync();
    } catch (error) {
      console.error("Failed to play audio", error);
    }
  };

  return (
    <View style={styles.expoAvContainer}>
      <Text style={styles.sectionTitle}>Expo AV Recording</Text>

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
          title="Start Expo-AV Recording"
          disabled={isRecording}
        />
        <Button
          onPress={stopRecording}
          title="Stop Expo-AV Recording"
          disabled={!isRecording}
        />
      </View>

      <View style={styles.buttonGroup}>
        <Text style={styles.sectionTitle}>Playback Controls</Text>
        <Button
          onPress={playRecording}
          title="Play Recording"
          disabled={!recordingUri}
        />
        {recordingUri && (
          <Text style={styles.recordingPathText}>
            URI: {recordingUri.substring(recordingUri.lastIndexOf("/") + 1)}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 50,
  },
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
  interactiveSection: {
    width: "80%",
    marginBottom: 20,
    padding: 15,
    backgroundColor: "#e3f2fd",
    borderRadius: 10,
    alignItems: "center",
  },
  slider: {
    width: "90%",
    height: 40,
    marginVertical: 10,
  },
  textInput: {
    width: "90%",
    height: 40,
    borderColor: "#ddd",
    borderWidth: 1,
    borderRadius: 5,
    padding: 10,
    marginVertical: 10,
  },
  counterContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 10,
  },
  counterButton: {
    width: 40,
    height: 40,
    backgroundColor: "#007AFF",
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    marginHorizontal: 10,
  },
  buttonText: {
    color: "white",
    fontSize: 20,
    fontWeight: "bold",
  },
  counterText: {
    fontSize: 20,
    width: 40,
    textAlign: "center",
  },
  colorButton: {
    width: "90%",
    height: 50,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
    marginVertical: 10,
  },
  colorButtonText: {
    color: "white",
    fontWeight: "bold",
  },
  chunkList: {
    width: "80%",
    marginBottom: 20,
    padding: 15,
    backgroundColor: "#f8f9fa",
    borderRadius: 10,
  },
  chunkScroller: {
    maxHeight: 200,
  },
  note: {
    fontSize: 12,
    color: "#ff9800",
    fontStyle: "italic",
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
  separator: {
    height: 5,
  },
  serverStatus: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  chunkItem: {
    flexDirection: "row",
    alignItems: "center",
  },
  uploadStatus: {
    marginLeft: 10,
    fontSize: 16,
  },
  serverResult: {
    width: "80%",
    marginBottom: 20,
    padding: 15,
    backgroundColor: "#f0f8ff",
    borderRadius: 10,
  },
  expoAvContainer: {
    width: "100%",
    alignItems: "center",
    marginTop: 20,
    backgroundColor: "#f0fff0",
    paddingVertical: 20,
    borderRadius: 10,
  },
  recordingPathText: {
    marginTop: 10,
    fontSize: 12,
    color: "#888",
    textAlign: "center",
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

export const isMicrophonePermissionGranted = async (): Promise<boolean> => {
  const { granted } = await Audio.getPermissionsAsync();
  return granted;
};
