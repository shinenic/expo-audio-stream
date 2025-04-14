## Introduction
This expo module's basic structure is based on the [expo-stream-audio](https://github.com/mykin-ai/expo-audio-stream) (commit [c41f25](https://github.com/mykin-ai/expo-audio-stream/commit/c41f25f76683d6e2f1fc531281deab032f579f9c)),

it's mainly designed for the scenario
- recording audio from the microphone
- realtime encoding to mp4
- upload the encoded mp4 file to the server in chunks
   - server can simply concatenate the chunks and save as a final file
- recoverable if the encoding is interrupted (at any time)
