錄音流程
1. 開始錄音
  - 啟動錄音 (audioEngine.start())
  - 建立 ffmpeg-kit pipe (FFmpegKitConfig.registerNewFFmpegPipe()) 
  - 取得 FileHandler
  - 建立文件寫入監聽 monitor file change (DispatchSource.makeFileSystemObjectSource)
2. audioEngine.inputNode.installTap 持續取得 pcm data 並且呼叫 `processAudioBuffer` 存入 `accumulatedBuffer`
3. `accumulatedBuffer` 每次更新後持續檢查根據上次更新的時間是否已經超過使用者設定的 interval，若超過則將 data 寫入 FileHandler，若沒有則持續累積
4. FileHandler 更新後 ffmpeg pipe 觸發 encode data，觸發更新後 DispatchSourceFileSystemObject 觸發更新，透過簡短的 debounce time 執行 `createAndEmitAudioChunk` 取得該次 `accumulatedBuffer` encode 後的資料
5. 將 encode 後的檔案比對前一輪的檔案，切分 buffer 後做備份 chunk file

錄音結束
1. 關閉 audioEngine
2. 手動更新 accumulatedBuffer 後將 data 寫入 FileHandler (忽略 interval)
3. 確保 fileHandle 已經寫入資料 (fileHandle.synchronizeFile(); fileHandle.closeFile())
4. 手動觸發 `closeFFmpegPipe`
5. FFmpegKit.executeAsync 的 session callback 會在處理完成後觸發，並且我們將 `isFFmpegCompleted` 設為 true
6. 觸發 `createAndEmitAudioChunk` 時檢查是否 `isFFmpegCompleted` 為 true，若為 true 則標記為 `isLastChunk` 並且停止監聽 file change

ffmpeg command
```
ffmpegCommand = "-f \(format) -ar \(sampleRate) -ac \(channels) -i \(pipe) -c:a aac -b:a 192k -flush_packets 1 -max_delay 0 -fflags nobuffer -flags low_delay -f mp4 -movflags frag_keyframe+empty_moov+faststart -frag_duration 1001000000000 -y \"\(mp4FileUrl.path)\""
```

