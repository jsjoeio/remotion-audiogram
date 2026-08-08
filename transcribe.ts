import path from "path";
import fs from "fs";
import os from "os";
import {
  downloadWhisperModel,
  installWhisperCpp,
  transcribe,
  toCaptions,
  type WhisperModel,
  type Language,
} from "@remotion/install-whisper-cpp";
import { execSync } from "child_process";
import * as readline from "readline";

const DEFAULT_AUDIO_PATH = "./public/dialogue.wav";
const DEFAULT_LANGUAGE: Language = "auto";
const DEFAULT_CAPTION_OFFSET_SECONDS = 0;

/** CI prepare writes this; srt-to-captions reads it to re-align timestamps. */
const SPEECH_START_CACHE_PATH = path.join(".cache", "speech-start.json");
/** Trimmed 16 kHz mono WAV for whisper-action (full dialogue.wav stays for Remotion). */
const WHISPER_INPUT_WAV = path.join(".cache", "dialogue-whisper.wav");

interface TranscriptionOptions {
  audioPath: string;
  speechStartsAtSecond: number;
  language?: Language;
  captionOffsetInSeconds?: number;
}

async function askQuestions(
  rl: readline.Interface,
): Promise<TranscriptionOptions> {
  const question = (query: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(query, resolve);
    });
  };

  // Ask for audio file path
  const audioPath =
    (await question(
      `❓ Path to audio file (default: ${DEFAULT_AUDIO_PATH}): `,
    )) || DEFAULT_AUDIO_PATH;

  // Auto-detect the moment actual speech (voice) begins. This makes the initial question easy.
  console.log("\n🔍 Detecting when speech begins in the audio (using ffmpeg silencedetect)...");
  const detectedSpeechStart = await detectSpeechStart(audioPath);
  console.log(`   → Detected speech begins at ${detectedSpeechStart}s`);

  // Ask for speech start time - this helps avoid false triggers from background music/noise
  const speechStartStr = await question(
    `❓ At what second does the actual speech begin? (detected: ${detectedSpeechStart}, default: use detected): `,
  );
  const speechStartsAtSecond = speechStartStr
    ? parseFloat(speechStartStr)
    : detectedSpeechStart;

  const languageInput = await question(
    `❓ Language (default: ${DEFAULT_LANGUAGE}, or e.g. Spanish, English, es): `,
  );
  const language = (languageInput || DEFAULT_LANGUAGE) as Language;

  // Extra offset for fine tuning caption sync without having to guess the begin time repeatedly.
  // Negative values (e.g. -0.12) make the text appear EARLIER relative to the audio.
  const captionOffsetStr = await question(
    `❓ Additional caption sync offset in seconds? (negative if text feels behind speech, e.g. -0.12; default: ${DEFAULT_CAPTION_OFFSET_SECONDS}): `,
  );
  const captionOffsetInSeconds = captionOffsetStr
    ? parseFloat(captionOffsetStr)
    : DEFAULT_CAPTION_OFFSET_SECONDS;

  return {
    audioPath,
    speechStartsAtSecond,
    language,
    captionOffsetInSeconds,
  };
}

async function transcribeAudio(options: TranscriptionOptions) {
  const WHISPER_VERSION = process.platform === "win32" ? "1.6.0" : "1.7.4";
  const WHISPER_MODEL: WhisperModel = "medium";
  const WHISPER_PATH = path.join(process.cwd(), "whisper.cpp");

  await installWhisperCpp({
    to: WHISPER_PATH,
    version: WHISPER_VERSION,
  });

  await downloadWhisperModel({
    model: WHISPER_MODEL,
    folder: WHISPER_PATH,
  });

  // Cut leading silence for cleaner Whisper input (same approach as CI prepare).
  // Extra captionOffsetInSeconds is applied only to final caption times (not the cut).
  const tempAudioForWhisper = path.join(
    os.tmpdir(),
    `whisper-${Date.now()}.wav`,
  );
  cutAudioForWhisper(
    options.audioPath,
    options.speechStartsAtSecond,
    tempAudioForWhisper,
  );

  const whisperCppOutput = await transcribe({
    model: WHISPER_MODEL,
    whisperPath: WHISPER_PATH,
    inputPath: tempAudioForWhisper,
    tokenLevelTimestamps: true,
    language: options.language ?? DEFAULT_LANGUAGE,
    whisperCppVersion: WHISPER_VERSION,
  });

  // Optional: Apply our recommended postprocessing
  const { captions } = toCaptions({
    whisperCppOutput,
  });

  // Total offset for captions = trim point used for whisper + any extra user sync offset.
  // The extra offset (esp. negative) lets you nudge text earlier/later without changing the detected speech start.
  const totalCaptionOffsetSeconds =
    options.speechStartsAtSecond + (options.captionOffsetInSeconds ?? 0);

  const adjustedCaptions = shiftCaptions(captions, totalCaptionOffsetSeconds);

  fs.writeFileSync(
    path.join(process.cwd(), "./public/captions.json"),
    JSON.stringify(adjustedCaptions, null, 2),
  );

  console.info(
    "Transcription complete. Check the captions.json file for the results.",
  );

  // Clean up temporary file
  fs.unlinkSync(tempAudioForWhisper);

  return adjustedCaptions;
}

async function startTranscribe() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const options = await askQuestions(rl);
    await transcribeAudio(options);
  } finally {
    // Close readline interface
    rl.close();
  }
}

// Only run the CLI if this file is run directly
if (require.main === module) {
  startTranscribe();
}

async function detectSpeechStart(audioPath: string): Promise<number> {
  try {
    const cmd = `npx remotion ffmpeg -i "${audioPath}" -af "silencedetect=noise=-50dB:duration=0.05" -f null - 2>&1`;
    const output = execSync(cmd, { encoding: "utf-8" });

    // Find the very first silence_end value (end of leading silence = start of speech)
    const match = output.match(/silence_end:\s*([\d.]+)/);
    if (match) {
      const detected = parseFloat(match[1]);
      // Clamp to >= 0 and round to milliseconds precision
      return Math.max(0, Math.round(detected * 1000) / 1000);
    }
  } catch (err) {
    console.warn("⚠️  Auto-detection of speech start failed, falling back to 0.");
  }
  return 0;
}

/**
 * Trim from speech start and convert to 16 kHz mono PCM WAV for Whisper.
 * Matches local remotion/whisper-cpp input prep.
 */
function cutAudioForWhisper(
  audioPath: string,
  speechStartsAtSecond: number,
  outputPath: string,
): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  execSync(
    `npx remotion ffmpeg -i "${audioPath}" -ss ${speechStartsAtSecond} -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}" -y`,
    { stdio: "inherit" },
  );
}

function saveSpeechStart(seconds: number): void {
  const dir = path.dirname(SPEECH_START_CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    SPEECH_START_CACHE_PATH,
    JSON.stringify({ seconds }, null, 2) + "\n",
  );
}

/** Offset applied in srt-to-captions so SRT times match full dialogue.wav. */
function loadSpeechStart(): number {
  if (!fs.existsSync(SPEECH_START_CACHE_PATH)) {
    return 0;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SPEECH_START_CACHE_PATH, "utf-8"));
    const seconds = Number(raw?.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return 0;
    }
    return seconds;
  } catch {
    return 0;
  }
}

/**
 * CI prepare: detect speech start, cache offset, write trimmed Whisper input.
 * Remotion keeps using full public/dialogue.wav; whisper-action uses the cache WAV.
 */
async function prepareWhisperInput(audioPath: string): Promise<{
  speechStartsAtSecond: number;
  whisperInputPath: string;
}> {
  const speechStartsAtSecond = await detectSpeechStart(audioPath);
  saveSpeechStart(speechStartsAtSecond);
  cutAudioForWhisper(audioPath, speechStartsAtSecond, WHISPER_INPUT_WAV);
  return { speechStartsAtSecond, whisperInputPath: WHISPER_INPUT_WAV };
}

function shiftCaptions<T extends { startMs: number; endMs: number; timestampMs?: number | null }>(
  captions: T[],
  offsetSeconds: number,
): T[] {
  if (offsetSeconds === 0) return captions;
  const offsetMs = offsetSeconds * 1000;
  return captions.map((caption) => ({
    ...caption,
    startMs: caption.startMs + offsetMs,
    endMs: caption.endMs + offsetMs,
    timestampMs: caption.timestampMs != null ? caption.timestampMs + offsetMs : null,
  }));
}

export {
  transcribeAudio,
  type TranscriptionOptions,
  detectSpeechStart,
  shiftCaptions,
  cutAudioForWhisper,
  prepareWhisperInput,
  loadSpeechStart,
  saveSpeechStart,
  SPEECH_START_CACHE_PATH,
  WHISPER_INPUT_WAV,
};
