import { Button, Platform, StyleSheet, Text, View } from "react-native";
import { ExpoPlayAudioStream } from "@mykin-ai/expo-audio-stream";
import { useEffect, useRef, useState } from "react";
import { sampleA } from "./samples/sample-a";
import { sampleB } from "./samples/sample-b";
import { sampleC } from "./samples/sample-c";
import {
  AudioDataEvent,
} from "@mykin-ai/expo-audio-stream/types";
import { Subscription } from "expo-modules-core";
import { Audio } from 'expo-av';

const ANDROID_SAMPLE_RATE = 16000;
const IOS_SAMPLE_RATE = 48000;
const CHANNELS = 1;
const ENCODING = "pcm_16bit";
const RECORDING_INTERVAL = 100;

const turnId1 = 'turnId1';
const turnId2 = 'turnId2';


export default function App() {


  const eventListenerSubscriptionRef = useRef<Subscription | undefined>(undefined);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);

  const onAudioCallback = async (audio: AudioDataEvent) => {
    // console.log(audio.data.slice(0, 100));
    console.log({
      ...audio,
      data: audio.data.slice(0, 100),
    })
  };

  const playEventsListenerSubscriptionRef = useRef<Subscription | undefined>(undefined);

  useEffect(() => {
    playEventsListenerSubscriptionRef.current = ExpoPlayAudioStream.subscribeToSoundChunkPlayed(async (event) => {
      console.log(event);
    });

    return () => {
      if (playEventsListenerSubscriptionRef.current) {
        playEventsListenerSubscriptionRef.current.remove();
        playEventsListenerSubscriptionRef.current = undefined;
      }
    }
  }, []);

  // Clean up sound object when component unmounts
  useEffect(() => {
    return () => {
      if (sound) {
        sound.unloadAsync();
      }
    };
  }, [sound]);

  const playRecording = async () => {
    try {
      if (!recordingUri) {
        console.log("No recording available");
        return;
      }
      
      // Unload any existing sound
      if (sound) {
        await sound.unloadAsync();
      }
      
      // Create and play the new sound
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: recordingUri }
      );
      setSound(newSound);
      await newSound.playAsync();
    } catch (error) {
      console.error("Failed to play recording", error);
    }
  };

  return (
    <View style={styles.container}>
      <Text>hi</Text>
      <Button
        onPress={async () => {
          const permissionGranted = await requestMicrophonePermission();
          if (!permissionGranted) {
            return;
          }
          await ExpoPlayAudioStream.playAudio(sampleA, turnId1);
        }}
        title="Request microphone permission"
      />
      <Button
        onPress={async () => {
          await ExpoPlayAudioStream.playAudio(sampleB, turnId1);
        }}
        title="Play sample B"
      />
      <View style={{ height: 10, marginBottom: 10 }}>
        <Text>====================</Text>
      </View>
      <Button
        onPress={async () => {
          await ExpoPlayAudioStream.pauseAudio();
        }}
        title="Pause Audio"
      />
      <View style={{ height: 10, marginBottom: 10 }}>
        <Text>====================</Text>
      </View>
      <Button
        onPress={async () => {
          await ExpoPlayAudioStream.playSound(sampleA, turnId2);
        }}
        title="Play sample A"
      />
      <View style={{ height: 10, marginBottom: 10 }}>
        <Text>====================</Text>
      </View>
      <Button
        onPress={async () => {
          await ExpoPlayAudioStream.playWav(sampleC);
        }}
        title="Play WAV fragment"
      />
       <View style={{ height: 10, marginBottom: 10 }}>
        <Text>====================</Text>
      </View>
      <Button
        onPress={async () => {
          if (!isMicrophonePermissionGranted()) {
            const permissionGranted = await requestMicrophonePermission();
            if (!permissionGranted) {
              return;
            }
          }
          const sampleRate =
            Platform.OS === "ios" ? IOS_SAMPLE_RATE : ANDROID_SAMPLE_RATE;
          const { recordingResult, subscription } = await ExpoPlayAudioStream.startMicrophone({
            interval: RECORDING_INTERVAL,
            sampleRate,
            channels: CHANNELS,
            encoding: ENCODING,
            onAudioStream: onAudioCallback,
          });
          console.log(JSON.stringify(recordingResult, null, 2 ));
          eventListenerSubscriptionRef.current = subscription;
        }}
        title="Start Recording"
      />
       <View style={{ height: 10, marginBottom: 10 }}>
        <Text>====================</Text>
      </View>
      <Button
        onPress={async () => {
          
         const recordingResult = await ExpoPlayAudioStream.stopMicrophone();
         console.log(JSON.stringify(recordingResult, null, 2));
         if (recordingResult?.fileUri) {
           setRecordingUri(recordingResult.fileUri);
         }
          if (eventListenerSubscriptionRef.current) {
            eventListenerSubscriptionRef.current.remove();
            eventListenerSubscriptionRef.current = undefined;
          }
        }}
        title="Stop Recording"
      />
       <View style={{ height: 10, marginBottom: 10 }}>
        <Text>====================</Text>
      </View>
      <Button
        onPress={playRecording}
        title="Play Recording"
        disabled={!recordingUri}
      />
      <View style={{ height: 10, marginBottom: 10 }}>
        <Text>====================</Text>
      </View>
      <Button
        onPress={async () => {
          await ExpoPlayAudioStream.clearPlaybackQueueByTurnId(turnId1);
        }}
        title="Clear turnId1"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
});

export const requestMicrophonePermission = async (): Promise<boolean> => {
  const { granted } = await Audio.getPermissionsAsync();
  let permissionGranted = granted;
  if (!permissionGranted) {
    const { granted: grantedPermission } = await Audio.requestPermissionsAsync();
    permissionGranted = grantedPermission;
  }
  return permissionGranted;
};

export const isMicrophonePermissionGranted = async (): Promise<boolean> => {
  const { granted } = await Audio.getPermissionsAsync();
  return granted;
};
