import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Language } from "@remotion/install-whisper-cpp";
import { convertAudio } from "./convert-audio";
import { CLIENT_CONFIG } from "./src/clientConfig";
import {
  fetchLatestPodcastJob,
  slugifyFilename,
  type PodcastMeta,
} from "./r2-podcast";
import {
  detectSpeechStart,
  transcribeAudio,
} from "./transcribe";
import { uploadVideoToTelegram } from "./upload-telegram";

const PUBLIC_DIR = "./public";
const OUTPUT_WAV = path.join(PUBLIC_DIR, "dialogue.wav");
const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_CAPTION_OFFSET_SECONDS = 0;

type StepTiming = {
  name: string;
  ms: number;
};

/** Human-readable duration, e.g. "842ms", "12.3s", "1m 24s". */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

async function timed<T>(
  name: string,
  fn: () => T | Promise<T>,
): Promise<{ result: T; timing: StepTiming }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { result, timing: { name, ms } };
}

function printTimingSummary(timings: StepTiming[], totalMs: number) {
  console.log("\n⏱  Timing");
  console.log("────────────────────────────");
  for (const { name, ms } of timings) {
    console.log(`  ${name.padEnd(12)} ${formatDuration(ms)}`);
  }
  console.log("────────────────────────────");
  console.log(`  ${"Total".padEnd(12)} ${formatDuration(totalMs)}`);
}

/** Prefer language from R2 meta; fall back to CLIENT_CONFIG if present. */
function resolveLanguage(meta: PodcastMeta): Language {
  const fromConfig = CLIENT_CONFIG[meta.clientKey]?.language;
  if (fromConfig) {
    return fromConfig;
  }
  return meta.language;
}

function resolveOutputPath(meta: PodcastMeta): string {
  const slug = slugifyFilename(meta.clientFullName, meta.podcastTitle);
  return path.join("out", `${slug}.mp4`);
}

function renderPhone(titleText: string, renderOutput: string) {
  const propsPath = path.join(
    os.tmpdir(),
    `audiogram-props-${Date.now()}.json`,
  );

  fs.writeFileSync(propsPath, JSON.stringify({ titleText }));

  const outDir = path.dirname(renderOutput);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.info(`\n🎬 Rendering phone video → ${renderOutput}`);
  console.info(`   titleText: ${titleText}`);

  try {
    // Same settings as package.json "render:phone"; title via --props so Root.tsx stays clean.
    execSync(
      `npx remotion render Audiogram "${renderOutput}" --video-bitrate=200k --audio-bitrate=96k --props="${propsPath}"`,
      { stdio: "inherit" },
    );
  } finally {
    if (fs.existsSync(propsPath)) {
      fs.unlinkSync(propsPath);
    }
  }
}

async function runPodcast() {
  console.log("🎙  Podcast pipeline\n");

  const pipelineStart = performance.now();
  const timings: StepTiming[] = [];

  // 0. Pull latest meta + audio from Cloudflare R2
  console.info(`☁  Step 0/5 — Download from R2`);
  const { result: job, timing: fetchTiming } = await timed("Download", () =>
    fetchLatestPodcastJob({
      audioDestDir: PUBLIC_DIR,
      audioBaseName: "dialogue",
    }),
  );
  timings.push(fetchTiming);
  console.info(`   ⏱  Download done in ${formatDuration(fetchTiming.ms)}`);

  const { meta, audioLocalPath, metaLocalPath, metaKey } = job;
  const language = resolveLanguage(meta);
  const titleText = `${meta.clientFullName} - ${meta.podcastTitle}`;
  const renderOutput = resolveOutputPath(meta);

  console.log("\n────────────────────────────");
  console.log(`Client:   ${meta.clientKey} (${meta.clientFullName})`);
  console.log(`Language: ${language}`);
  console.log(`Title:    ${meta.podcastTitle}`);
  console.log(`Display:  ${titleText}`);
  console.log(`Meta:     ${metaKey}`);
  console.log(`Audio:    ${audioLocalPath}`);
  console.log(`Cached:   ${metaLocalPath}`);
  console.log(`Output:   ${renderOutput}`);
  console.log("────────────────────────────\n");

  // 1. Convert audio → public/dialogue.wav (defaults: 48kHz mono PCM)
  console.info(`\n🔊 Step 1/5 — Convert audio`);
  console.info(`   Input: ${audioLocalPath}`);
  {
    const { timing } = await timed("Convert", () =>
      convertAudio({
        inputPath: audioLocalPath,
        outputPath: OUTPUT_WAV,
        sampleRate: DEFAULT_SAMPLE_RATE,
      }),
    );
    timings.push(timing);
    console.info(`   ⏱  Convert done in ${formatDuration(timing.ms)}`);
  }

  // 2. Transcribe with client language + auto-detected speech start
  console.info(`\n📝 Step 2/5 — Transcribe`);
  console.info(
    "   Detecting when speech begins (ffmpeg silencedetect)...",
  );
  {
    const { timing } = await timed("Transcribe", async () => {
      const speechStartsAtSecond = await detectSpeechStart(OUTPUT_WAV);
      console.info(`   → Speech begins at ${speechStartsAtSecond}s`);
      console.info(`   Language: ${language}`);

      await transcribeAudio({
        audioPath: OUTPUT_WAV,
        speechStartsAtSecond,
        language,
        captionOffsetInSeconds: DEFAULT_CAPTION_OFFSET_SECONDS,
      });
    });
    timings.push(timing);
    console.info(`   ⏱  Transcribe done in ${formatDuration(timing.ms)}`);
  }

  // 3. Render phone-optimized video with dynamic title (no Root.tsx edit)
  console.info(`\n🎥 Step 3/5 — Render`);
  {
    const { timing } = await timed("Render", () =>
      renderPhone(titleText, renderOutput),
    );
    timings.push(timing);
    console.info(`   ⏱  Render done in ${formatDuration(timing.ms)}`);
  }

  // 4. DM yourself the finished MP4 via Telegram bot
  console.info(`\n📤 Step 4/5 — Upload to Telegram`);
  {
    const { timing } = await timed("Telegram", () =>
      uploadVideoToTelegram({
        filePath: renderOutput,
        caption: titleText,
      }),
    );
    timings.push(timing);
    console.info(`   ⏱  Telegram done in ${formatDuration(timing.ms)}`);
  }

  const totalMs = performance.now() - pipelineStart;

  console.log("\n✅ Done.");
  console.log(`   Client:  ${meta.clientFullName}`);
  console.log(`   Podcast: ${meta.podcastTitle}`);
  console.log(`   Video:   ${renderOutput}`);
  console.log(`   Sent:    Telegram DM`);
  printTimingSummary(timings, totalMs);
}

if (require.main === module) {
  runPodcast().catch((err) => {
    console.error("\n❌ Podcast pipeline failed:");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { runPodcast };
