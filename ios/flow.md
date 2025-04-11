錄音流程
1. 開始錄音
  - 啟動錄音 (audioEngine.start())
  - 建立 ffmpeg-kit pipe (FFmpegKitConfig.registerNewFFmpegPipe()) 
  - 取得 FileHandler
  - 建立文件寫入監聽 monitor file change (DispatchSource.makeFileSystemObjectSource)
2. audioEngine.inputNode.installTap 持續取得 pcm data 並且存入 accumulatedBuffer
3. accumulatedBuffer 每次更新後持續檢查根據上次更新的時間是否已經超過使用者設定的 interval，若超過則將 data 寫入 FileHandler，若沒有則持續累積
4. FileHandler 更新後 ffmpeg pipe 觸發 encode data，觸發更新後 DispatchSourceFileSystemObject 觸發更新，透過簡短的 debounce time 取得該次 accumulatedBuffer encode 後的資料
5. 將 encode 後的檔案比對前一輪的檔案，切分 buffer 後做備份 chunk file


ffmpeg command
```
ffmpegCommand = "-f \(format) -ar \(sampleRate) -ac \(channels) -i \(pipe) -c:a aac -b:a 128k -flush_packets 1 -max_delay 0 -fflags nobuffer -flags low_delay -f mp4 -movflags frag_keyframe+empty_moov+faststart -frag_duration 100000 -y \"\(mp4FileUrl.path)\""
```



Refactor:
- 移除...