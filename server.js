const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
const upload = multer({ dest: "uploads/" });
const sessions = new Map();

app.use(cors());
app.use(express.json());
app.use("/static", express.static("static"));

// Create a temporary directory for each session
app.post("/start", (req, res) => {
  console.log("Received request to start a new session");
  const sessionId = uuidv4();
  const sessionDir = path.join("sessions", sessionId);

  fs.mkdirSync(sessionDir, { recursive: true });
  sessions.set(sessionId, {
    dir: sessionDir,
    chunks: [],
  });

  console.log(`Session started with ID: ${sessionId}`);
  res.json({ sessionId });
});

// Handle chunk upload
app.post("/upload-chunk", upload.single("chunk"), (req, res) => {
  console.log("Received request to upload a chunk");
  const { id, index } = req.query;
  const session = sessions.get(id);

  if (!session) {
    console.log("Session not found for ID:", id);
    return res.status(404).json({ error: "Session not found" });
  }

  if (!req.file) {
    console.log("No file uploaded for session ID:", id);
    return res.status(400).json({ error: "No file uploaded" });
  }

  const chunkPath = path.join(session.dir, `chunk_${index}.wav`);
  fs.renameSync(req.file.path, chunkPath);
  session.chunks.push(chunkPath);

  console.log(`Chunk ${index} uploaded for session ID: ${id}`);
  res.json({ success: true });
});

// Complete recording and concatenate chunks
app.post("/complete", async (req, res) => {
  console.log("Received request to complete session");
  const { id } = req.query;
  const session = sessions.get(id);

  if (!session) {
    console.log("Session not found for ID:", id);
    return res.status(404).json({ error: "Session not found" });
  }

  try {
    // Create concat file with absolute paths
    const concatFile = path.join(session.dir, "concat.txt");
    const concatContent = session.chunks
      .map((chunk) => `file '${path.resolve(chunk)}'`)
      .join("\n");
    fs.writeFileSync(concatFile, concatContent);

    // Create output directory if it doesn't exist
    fs.mkdirSync("static", { recursive: true });

    // Generate output filename
    const outputFilename = `output_${id}.mp3`;
    const outputPath = path.join("static", outputFilename);

    console.log(`Processing audio for session ID: ${id}`);
    console.log(`Concat file content:\n${concatContent}`);

    // Concatenate and convert to MP3 using FFmpeg
    const ffmpegCommand = `ffmpeg -f concat -safe 0 -i "${concatFile}" -c:a libmp3lame -q:a 0 -ar 44100 -ac 2 -b:a 320k -y "${outputPath}"`;

    console.log(`Executing FFmpeg command: ${ffmpegCommand}`);

    exec(ffmpegCommand, (error, stdout, stderr) => {
      if (error) {
        console.error("FFmpeg error:", error);
        console.error("FFmpeg stderr:", stderr);
        return res.status(500).json({ error: "Failed to process audio" });
      }

      // Clean up session files
      try {
        fs.rmSync(session.dir, { recursive: true, force: true });
        sessions.delete(id);
      } catch (cleanupError) {
        console.error("Error cleaning up session files:", cleanupError);
      }

      console.log(`Audio processing complete for session ID: ${id}`);
      // Return the static file URL
      res.json({
        url: `/static/${outputFilename}`,
        filename: outputFilename,
      });
    });
  } catch (error) {
    console.error("Error processing audio:", error);
    res.status(500).json({ error: "Failed to process audio" });
  }
});

// Clean up old sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    try {
      // Remove sessions older than 1 hour
      if (now - session.startTime > 3600000) {
        fs.rmSync(session.dir, { recursive: true, force: true });
        sessions.delete(id);
        console.log(`Cleaned up old session: ${id}`);
      }
    } catch (error) {
      console.error(`Error cleaning up session ${id}:`, error);
    }
  }
}, 3600000); // Check every hour

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
