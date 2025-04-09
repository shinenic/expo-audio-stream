import * as FileSystem from "expo-file-system";
import { BehaviorSubject, filter, firstValueFrom } from "rxjs";

const API = "http://localhost:3000";

class Uploader {
  private sessionId$ = new BehaviorSubject<string | null>(null);
  private chunks: { uri: string; index: number }[] = [];

  constructor() {
    fetch(`${API}/start`).then((res) => {
      res.json().then((data) => {
        this.sessionId$.next(data.sessionId);
      });
    });
  }

  public addChunk(chunk: { uri: string; index: number }) {
    this.chunks.push(chunk);

    this.doTask();
  }

  private async doTask() {
    const sessionId = await firstValueFrom(
      this.sessionId$.pipe(filter((v) => typeof v === "string"))
    );

    const chunk = this.chunks.shift();

    if (!chunk) {
      return;
    }

    const uploadOptions = {
      // fieldName: file.name,
      // parameters: { command: "user.upload" },
      headers: { "Content-Type": "multipart/form-data" },
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      /**
       * @note background mode may be slow on iOS dev mode
       * @ref https://github.com/expo/expo/issues/26754
       */
      // sessionType:
      //   options?.mode === "background"
      //     ? FileSystem.FileSystemSessionType.BACKGROUND
      //     : FileSystem.FileSystemSessionType.FOREGROUND,
      sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
    } satisfies FileSystem.FileSystemUploadOptions;

    const task = FileSystem.createUploadTask(
      `${API}/upload-chunk?id=${sessionId}&index=${chunk.index}`,
      chunk.uri,
      uploadOptions
    );

    const response = await task.uploadAsync();

    if (response?.status !== 200) {
      throw new Error("Upload failed");
    }

    return true;
  }
}
