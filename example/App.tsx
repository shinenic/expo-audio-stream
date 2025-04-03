import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useState } from "react";
import Slider from "@react-native-community/slider";
import CustomRecorder from "./components/CustomRecorder";
import ExpoAVRecorder from "./components/ExpoAVRecorder";

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

      <CustomRecorder />
      <ExpoAVRecorder />
    </ScrollView>
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
  recorderContainer: {
    width: "100%",
    alignItems: "center",
  },
});
