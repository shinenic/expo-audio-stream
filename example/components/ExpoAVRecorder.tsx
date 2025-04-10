import { Button, StyleSheet, Text, View } from "react-native";
import { useEffect, useRef, useState } from "react";
import { Audio } from "expo-av";

export default function ExpoAVRecorder() {
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
