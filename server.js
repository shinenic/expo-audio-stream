const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const ffmpeg = require("fluent-ffmpeg");

const app = express();
const upload = multer({ dest: "uploads/" });

// Store active sessions
const sessions = new Map();

app.post("/start", (req, res) => {
  console.log("Received request to start a new session");
  const sessionId = uuidv4();
  const sessionDir = path.join("uploads", sessionId);

  // Create session directory
  fs.mkdirSync(sessionDir, { recursive: true });
  console.log(`Session directory created at ${sessionDir}`);

  // Store session info
  sessions.set(sessionId, {
    dir: sessionDir,
    chunks: [],
    totalChunks: 0,
  });
  console.log(`Session started with ID: ${sessionId}`);

  res.json({ sessionId });
});

app.post("/upload-chunk", upload.single("chunk"), (req, res) => {
  console.log("Received request to upload a chunk");
  const { id, index } = req.query;
  const session = sessions.get(id);

  if (!session) {
    console.log(`Session not found for ID: ${id}`);
    return res.status(404).json({ error: "Session not found" });
  }

  if (!req.file) {
    console.log("No file uploaded in the request");
    return res.status(400).json({ error: "No file uploaded" });
  }

  const chunkPath = path.join(session.dir, `chunk_${index}.wav`);
  fs.renameSync(req.file.path, chunkPath);
  console.log(`Chunk saved at ${chunkPath}`);

  session.chunks.push(chunkPath);
  session.totalChunks = Math.max(session.totalChunks, parseInt(index) + 1);
  console.log(`Chunk ${index} uploaded for session ID: ${id}`);

  res.json({ success: true });
});

app.post("/complete", async (req, res) => {
  console.log("Received request to complete session");
  const { id } = req.query;
  const session = sessions.get(id);

  if (!session) {
    console.log(`Session not found for ID: ${id}`);
    return res.status(404).json({ error: "Session not found" });
  }

  if (session.chunks.length !== session.totalChunks) {
    console.log(`Not all chunks uploaded for session ID: ${id}`);
    return res.status(400).json({ error: "Not all chunks uploaded" });
  }

  const outputDir = path.join("public", "audio");
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`Output directory ensured at ${outputDir}`);

  const outputFile = path.join(outputDir, `${id}.wav`);

  try {
    // Sort chunks by index
    const sortedChunks = session.chunks.sort((a, b) => {
      const indexA = parseInt(path.basename(a).split("_")[1]);
      const indexB = parseInt(path.basename(b).split("_")[1]);
      return indexA - indexB;
    });

    const listFile = path.join(session.dir, "list.txt");

    // Create a file list for ffmpeg with relative paths
    const fileList = sortedChunks
      .map((file) => `file '${path.basename(file)}'`)
      .join("\n");

    fs.writeFileSync(listFile, fileList);
    console.log(`File list created at ${listFile}`);
    console.log(`File list contents: ${fileList}`);

    // Merge chunks using ffmpeg with absolute paths
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(path.resolve(listFile))
        .inputOptions(["-f concat", "-safe 0"])
        .output(path.resolve(outputFile))
        .on("start", (commandLine) => {
          console.log("FFmpeg command:", commandLine);
        })
        .on("end", () => {
          console.log(`Chunks merged successfully into ${outputFile}`);
          resolve();
        })
        .on("error", (error) => {
          console.error("Error during merging:", error);
          reject(error);
        })
        .run();
    });

    // Clean up session files
    fs.rmSync(session.dir, { recursive: true, force: true });
    sessions.delete(id);
    console.log(`Session files cleaned up for ID: ${id}`);

    // Return the static URL
    res.json({
      url: `/audio/${id}.wav`,
      fileSize: fs.statSync(outputFile).size,
    });
  } catch (error) {
    console.error("Error merging chunks:", error);
    res.status(500).json({ error: "Failed to merge chunks" });
  }
});

// Serve static files from public directory
app.use("/audio", express.static(path.join(__dirname, "public", "audio")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
