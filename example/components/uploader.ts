import * as FileSystem from "expo-file-system";
import { BehaviorSubject, filter, firstValueFrom } from "rxjs";

// const API =
// "https://4e2c-2401-e180-8841-111b-94bb-e599-605a-9e45.ngrok-free.app";
// const API = "http://192.168.1.123:3000";
const API = "http://localhost:3000";

export class Uploader {
  private sessionId$ = new BehaviorSubject<string | null>(null);
  private chunks: { uri: string; index: number }[] = [];
  private statusMap$ = new BehaviorSubject<{
    [key: number]: "pending" | "uploading" | "failed" | "uploaded";
  }>({});

  constructor() {
    fetch(`${API}/start`, {
      method: "POST",
    }).then((res) => {
      res.json().then((data) => {
        this.sessionId$.next(data.sessionId);
      });
    });
  }

  public addChunk(chunk: { uri: string; index: number }) {
    this.chunks.push(chunk);
    this.statusMap$.next({
      ...this.statusMap$.value,
      [chunk.index]: "pending",
    });

    this.doTask();
  }

  public async done() {
    const id = await firstValueFrom(
      this.sessionId$.pipe(filter((v) => typeof v === "string"))
    );

    console.log("Waiting for all chunks to be uploaded");
    await firstValueFrom(
      this.statusMap$.pipe(
        filter((v) => {
          return Object.values(v).every((status) => status === "uploaded");
        })
      )
    );
    console.log("All chunks uploaded");

    this.chunks = [];
    this.statusMap$.next({});

    const res = await fetch(`${API}/complete?id=${id}`, {
      method: "POST",
    });

    return res.json();
  }

  /**
   * @TODO delete the chunk file
   */
  private async doTask() {
    const sessionId = await firstValueFrom(
      this.sessionId$.pipe(filter((v) => typeof v === "string"))
    );

    const chunk = this.chunks.shift();

    if (!chunk) {
      return;
    }

    this.statusMap$.next({
      ...this.statusMap$.value,
      [chunk.index]: "uploading",
    });

    const uploadOptions = {
      fieldName: "chunk",
      headers: { "Content-Type": "multipart/form-data" },
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
    } satisfies FileSystem.FileSystemUploadOptions;

    const task = FileSystem.createUploadTask(
      `${API}/upload-chunk?id=${sessionId}&index=${chunk.index}`,
      chunk.uri,
      uploadOptions
    );

    const response = await task.uploadAsync();

    if (response?.status !== 200) {
      this.statusMap$.next({
        ...this.statusMap$.value,
        [chunk.index]: "failed",
      });
      throw new Error("Upload failed");
    }

    this.statusMap$.next({
      ...this.statusMap$.value,
      [chunk.index]: "uploaded",
    });

    return true;
  }

  /**
   * @TODO on destroy
   */
}
