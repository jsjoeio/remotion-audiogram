import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Language } from "@remotion/install-whisper-cpp";
import { convertAudio } from "./convert-audio";
import { CLIENT_CONFIG } from "./src/clientConfig";
import {
  fetchLatestPodcastJob,
  loadCachedPodcastMeta,
  slugifyFilename,
  type PodcastMeta,
} from "./r2-podcast";
import {
  detectSpeechStart,
  prepareWhisperInput,
  transcribeAudio,
  WHISPER_INPUT_WAV,
} from "./transcribe";
import { uploadVideoToTelegram } from "./upload-telegram";

const PUBLIC_DIR = "./public";
const OUTPUT_WAV = path.join(PUBLIC_DIR, "dialogue.wav");
const CAPTIONS_JSON = path.join(PUBLIC_DIR, "captions.json");
const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_CAPTION_OFFSET_SECONDS = 0;

type StepTiming = {
  name: string;
  ms: number;
};

/** CLI modes: full (default), prepare (CI pre-whisper), finish (CI post-whisper). */
type Mode = "full" | "prepare" | "finish";

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

function parseMode(argv: string[]): Mode {
  const arg = argv[2];
  if (arg === "prepare" || arg === "finish" || arg === "full") {
    return arg;
  }
  if (arg && !arg.startsWith("-")) {
    console.error(`Unknown mode "${arg}". Use: full | prepare | finish`);
    process.exit(1);
  }
  return "full";
}

async function stepDownloadConvert(timings: StepTiming[]) {
  console.info(`☁  Step — Download from R2`);
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

  console.info(`\n🔊 Step — Convert audio`);
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

  return { meta, language, titleText, renderOutput };
}

async function stepTranscribeLocal(
  language: Language,
  timings: StepTiming[],
) {
  console.info(`\n📝 Step — Transcribe (local whisper.cpp)`);
  console.info("   Detecting when speech begins (ffmpeg silencedetect)...");
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
}

async function stepRenderUpload(
  titleText: string,
  renderOutput: string,
  meta: PodcastMeta,
  timings: StepTiming[],
) {
  if (!fs.existsSync(CAPTIONS_JSON)) {
    throw new Error(
      `Missing ${CAPTIONS_JSON}. Transcribe first (local) or run srt-to-captions (CI).`,
    );
  }
  if (!fs.existsSync(OUTPUT_WAV)) {
    throw new Error(`Missing ${OUTPUT_WAV}. Run prepare/convert first.`);
  }

  console.info(`\n🎥 Step — Render`);
  {
    const { timing } = await timed("Render", () =>
      renderPhone(titleText, renderOutput),
    );
    timings.push(timing);
    console.info(`   ⏱  Render done in ${formatDuration(timing.ms)}`);
  }

  console.info(`\n📤 Step — Upload to Telegram`);
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

  console.log("\n✅ Done.");
  console.log(`   Client:  ${meta.clientFullName}`);
  console.log(`   Podcast: ${meta.podcastTitle}`);
  console.log(`   Video:   ${renderOutput}`);
  console.log(`   Sent:    Telegram DM`);
}

async function runPodcast(mode: Mode = "full") {
  console.log(`🎙  Podcast pipeline (mode: ${mode})\n`);

  const pipelineStart = performance.now();
  const timings: StepTiming[] = [];

  if (mode === "prepare") {
    await stepDownloadConvert(timings);

    // Same speech-start trim as local transcribe: Whisper gets a clean clip;
    // srt-to-captions shifts SRT times back onto the full dialogue.wav timeline.
    console.info(`\n✂️  Step — Prepare Whisper input (detect speech + trim)`);
    {
      const { result, timing } = await timed("Whisper prep", async () => {
        const { speechStartsAtSecond, whisperInputPath } =
          await prepareWhisperInput(OUTPUT_WAV);
        console.info(`   → Speech begins at ${speechStartsAtSecond}s`);
        console.info(`   → Whisper input: ${whisperInputPath}`);
        return { speechStartsAtSecond, whisperInputPath };
      });
      timings.push(timing);
      console.info(
        `   ⏱  Whisper prep done in ${formatDuration(timing.ms)} (speech @ ${result.speechStartsAtSecond}s)`,
      );
    }

    const totalMs = performance.now() - pipelineStart;
    console.log("\n✅ Prepare done (audio ready for Whisper).");
    console.log(`   Full WAV (Remotion): ${OUTPUT_WAV}`);
    console.log(`   Whisper WAV (trimmed): ${WHISPER_INPUT_WAV}`);
    printTimingSummary(timings, totalMs);
    return;
  }

  if (mode === "finish") {
    const meta = loadCachedPodcastMeta();
    const titleText = `${meta.clientFullName} - ${meta.podcastTitle}`;
    const renderOutput = resolveOutputPath(meta);
    console.log("\n────────────────────────────");
    console.log(`Client:   ${meta.clientKey} (${meta.clientFullName})`);
    console.log(`Title:    ${meta.podcastTitle}`);
    console.log(`Captions: ${CAPTIONS_JSON}`);
    console.log(`Output:   ${renderOutput}`);
    console.log("────────────────────────────\n");
    await stepRenderUpload(titleText, renderOutput, meta, timings);
    printTimingSummary(timings, performance.now() - pipelineStart);
    return;
  }

  // full — local path with whisper.cpp
  const { meta, language, titleText, renderOutput } =
    await stepDownloadConvert(timings);
  await stepTranscribeLocal(language, timings);
  await stepRenderUpload(titleText, renderOutput, meta, timings);
  printTimingSummary(timings, performance.now() - pipelineStart);
}

if (require.main === module) {
  const mode = parseMode(process.argv);
  runPodcast(mode).catch((err) => {
    console.error("\n❌ Podcast pipeline failed:");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { runPodcast };
