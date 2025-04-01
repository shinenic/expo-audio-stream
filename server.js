const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");

const app = express();
const port = 3000;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const id = req.query.id;
    const dir = path.join(__dirname, "uploads", id);
    console.log(`Storing file for session ID: ${id} at ${dir}`);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const index = req.query.index;
    console.log(`Saving chunk with index: ${index}`);
    cb(null, `chunk_${index}.webm`);
  },
});

const upload = multer({ storage });

if (!fs.existsSync(path.join(__dirname, "uploads"))) {
  console.log("Creating uploads directory");
  fs.mkdirSync(path.join(__dirname, "uploads"));
}

app.get("/start", (req, res) => {
  const id = req.query.id;

  if (!id) {
    console.log("Missing id parameter in /start endpoint");
    return res.status(400).json({ error: "Missing id parameter" });
  }

  const dir = path.join(__dirname, "uploads", id);

  if (fs.existsSync(dir)) {
    console.log(`Clearing existing directory for session ID: ${id}`);
    fs.readdirSync(dir).forEach((file) => {
      fs.unlinkSync(path.join(dir, file));
    });
  } else {
    console.log(`Creating directory for session ID: ${id}`);
    fs.mkdirSync(dir, { recursive: true });
  }

  res.json({ success: true, id, directory: dir });
});

app.post("/upload-chunk", upload.single("chunk"), (req, res) => {
  const id = req.query.id;
  const index = req.query.index;

  if (!id || !index || !req.file) {
    console.log("Missing required parameters in /upload-chunk endpoint");
    return res.status(400).json({ error: "Missing required parameters" });
  }

  console.log(`Received chunk ${index} for session ID: ${id}`);

  res.json({
    success: true,
    id,
    index,
    file: req.file.path,
    size: req.file.size,
  });
});

app.get("/finish", async (req, res) => {
  const id = req.query.id;

  if (!id) {
    console.log("Missing id parameter in /finish endpoint");
    return res.status(400).json({ error: "Missing id parameter" });
  }

  const dir = path.join(__dirname, "uploads", id);

  if (!fs.existsSync(dir)) {
    console.log(`Directory not found for session ID: ${id}`);
    return res.status(404).json({ error: "Directory not found" });
  }

  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".webm"))
    .sort((a, b) => {
      const indexA = parseInt(a.match(/chunk_(\d+)\.webm/)?.[1] || "0");
      const indexB = parseInt(b.match(/chunk_(\d+)\.webm/)?.[1] || "0");
      return indexA - indexB;
    });

  if (files.length === 0) {
    console.log(`No audio chunks found for session ID: ${id}`);
    return res.status(404).json({ error: "No audio chunks found" });
  }

  const chunksToMerge = files.length > 1 ? files.slice(1) : files;

  if (chunksToMerge.length === 0) {
    console.log(`No valid audio chunks to merge for session ID: ${id}`);
    return res.status(404).json({ error: "No valid audio chunks to merge" });
  }

  const concatUuid = uuidv4();
  const outputFile = path.join(dir, `concat_${concatUuid}.webm`);
  const wavOutputFile = path.join(dir, `concat_${concatUuid}.wav`);

  try {
    let command = ffmpeg();

    chunksToMerge.forEach((file) => {
      console.log(`Adding file to merge: ${file}`);
      command = command.input(path.join(dir, file));
    });

    let filterComplex = "";
    for (let i = 0; i < chunksToMerge.length; i++) {
      filterComplex += `[${i}:a]`;
    }
    filterComplex += `concat=n=${chunksToMerge.length}:v=0:a=1[aout]`;

    await new Promise((resolve, reject) => {
      command
        .complexFilter(filterComplex)
        .map("[aout]")
        .outputOption("-c:a libopus")
        .outputOption("-b:a 128k")
        .outputOption("-application audio")
        .outputOption("-avoid_negative_ts make_zero")
        .outputOption("-fflags +bitexact")
        .save(outputFile)
        .on("end", () => {
          console.log(
            `Successfully concatenated WebM chunks for session ID: ${id}`
          );
          resolve();
        })
        .on("error", (err) => {
          console.error("Error during WebM concatenation:", err);
          reject(err);
        });
    });

    const fileStats = fs.statSync(outputFile);
    const fileSize = fileStats.size;

    const getDuration = () => {
      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(outputFile, (err, metadata) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(
            metadata.format.duration
              ? Math.floor(metadata.format.duration * 1000)
              : 0
          );
        });
      });
    };

    const durationMs = await getDuration();

    await new Promise((resolve, reject) => {
      ffmpeg(outputFile)
        .outputOption("-acodec pcm_s16le")
        .save(wavOutputFile)
        .on("end", () => {
          console.log(
            `Successfully converted WebM to WAV for session ID: ${id}`
          );
          resolve();
        })
        .on("error", (err) => {
          console.error("Error during WAV conversion:", err);
          reject(err);
        });
    });

    const wavStats = fs.statSync(wavOutputFile);
    const wavSize = wavStats.size;

    res.json({
      fileUri: `file://${wavOutputFile}`,
      filename: path.basename(wavOutputFile),
      durationMs: durationMs,
      size: wavSize,
      channels: 1,
      bitDepth: 16,
      sampleRate: 48000,
      mimeType: "audio/wav",
      concatFileUri: `file://${outputFile}`,
      concatFilename: path.basename(outputFile),
      concatDurationMs: durationMs,
      concatSize: fileSize,
      concatMimeType: "audio/webm",
    });
  } catch (error) {
    console.error("Error processing audio:", error);
    res.status(500).json({
      error: "Failed to process audio",
      details: error,
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
