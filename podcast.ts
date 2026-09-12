import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Language } from "@remotion/install-whisper-cpp";
import { convertAudio } from "./convert-audio";
import { enhanceAudio } from "./enhance-audio";
import { getClientByKey } from "./d1-clients";
import { publishEnhancedAudioForApp } from "./encode-public-audio";
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
import { notifyAdminPodcastReady } from "./notify-admin-callback";
import { sendPublicAudioLinkToTelegram } from "./notify-telegram-link";
import { uploadVideoToTelegram } from "./upload-telegram";

const PUBLIC_DIR = "./public";
/** Unprocessed PCM after convert — kept for A/B debug. */
const RAW_WAV = path.join(PUBLIC_DIR, "dialogue.raw.wav");
/** Enhanced PCM used by Whisper trim + Remotion / public AAC encode. */
const OUTPUT_WAV = path.join(PUBLIC_DIR, "dialogue.wav");
const CAPTIONS_JSON = path.join(PUBLIC_DIR, "captions.json");
const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_CAPTION_OFFSET_SECONDS = 0;

type StepTiming = {
  name: string;
  ms: number;
};

/**
 * CLI modes:
 *   full     — local: download → enhance → whisper.cpp → render → Telegram
 *   prepare  — CI pre-whisper (includes speech-start trim for Whisper)
 *   finish   — CI post-whisper: render → Telegram
 *   app      — app.jsjoe.io path: download → enhance → AAC → public R2
 *              → optional admin callback + Telegram topic with public URL
 *              (no Whisper / Remotion)
 */
type Mode = "full" | "prepare" | "finish" | "app";

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
  console.log("\n\u23f1  Timing");
  console.log("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  for (const { name, ms } of timings) {
    console.log(`  ${name.padEnd(12)} ${formatDuration(ms)}`);
  }
  console.log("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  console.log(`  ${"Total".padEnd(12)} ${formatDuration(totalMs)}`);
}

/** true / 1 / yes (case-insensitive). Empty/absent = false (push triggers). */
function isTruthyEnv(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Prefer language from D1 clients table (source of truth); fall back to R2 meta.
 * D1 lookup is best-effort so offline / missing wrangler still works with meta.
 */
function resolveLanguage(meta: PodcastMeta): Language {
  try {
    const fromD1 = getClientByKey(meta.clientKey)?.language;
    if (fromD1) {
      return fromD1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`   \u26a0  D1 clients unavailable (${msg}); using meta.language`);
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

  console.info(`\n\ud83c\udfac Rendering phone video \u2192 ${renderOutput}`);
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
  if (arg === "prepare" || arg === "finish" || arg === "full" || arg === "app") {
    return arg;
  }
  if (arg && !arg.startsWith("-")) {
    console.error(`Unknown mode "${arg}". Use: full | prepare | finish | app`);
    process.exit(1);
  }
  return "full";
}

async function stepDownloadConvert(timings: StepTiming[]) {
  console.info(`\u2601  Step \u2014 Download from R2`);
  const { result: job, timing: fetchTiming } = await timed("Download", () =>
    fetchLatestPodcastJob({
      audioDestDir: PUBLIC_DIR,
      audioBaseName: "dialogue",
    }),
  );
  timings.push(fetchTiming);
  console.info(`   \u23f1  Download done in ${formatDuration(fetchTiming.ms)}`);

  const { meta, audioLocalPath, metaLocalPath, metaKey } = job;
  const language = resolveLanguage(meta);
  const titleText = `${meta.clientFullName} - ${meta.podcastTitle}`;
  const renderOutput = resolveOutputPath(meta);

  console.log("\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  console.log(`Client:   ${meta.clientKey} (${meta.clientFullName})`);
  console.log(`Language: ${language}`);
  console.log(`Title:    ${meta.podcastTitle}`);
  console.log(`Display:  ${titleText}`);
  console.log(`Meta:     ${metaKey}`);
  console.log(`Audio:    ${audioLocalPath}`);
  console.log(`Cached:   ${metaLocalPath}`);
  console.log(`Output:   ${renderOutput}`);
  console.log("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");

  console.info(`\n\ud83d\udd0a Step \u2014 Convert audio`);
  console.info(`   Input: ${audioLocalPath}`);
  {
    const { timing } = await timed("Convert", () =>
      convertAudio({
        inputPath: audioLocalPath,
        outputPath: RAW_WAV,
        sampleRate: DEFAULT_SAMPLE_RATE,
      }),
    );
    timings.push(timing);
    console.info(`   \u23f1  Convert done in ${formatDuration(timing.ms)}`);
  }

  // Enhance the full WAV before Whisper trim / Remotion / public AAC.
  console.info(`\n\ud83c\udf9a  Step \u2014 Enhance audio (podcast loudness)`);
  console.info(`   Raw:       ${RAW_WAV}`);
  console.info(`   Processed: ${OUTPUT_WAV}`);
  {
    const { timing } = await timed("Enhance", () =>
      enhanceAudio({
        inputPath: RAW_WAV,
        outputPath: OUTPUT_WAV,
        sampleRate: DEFAULT_SAMPLE_RATE,
      }),
    );
    timings.push(timing);
    console.info(`   \u23f1  Enhance done in ${formatDuration(timing.ms)}`);
  }

  return { meta, metaKey, language, titleText, renderOutput };
}

async function stepTranscribeLocal(language: Language, timings: StepTiming[]) {
  console.info(`\n\ud83d\udcdd Step \u2014 Transcribe (local whisper.cpp)`);
  console.info("   Detecting when speech begins (ffmpeg silencedetect)...");
  {
    const { timing } = await timed("Transcribe", async () => {
      const speechStartsAtSecond = await detectSpeechStart(OUTPUT_WAV);
      console.info(`   \u2192 Speech begins at ${speechStartsAtSecond}s`);
      console.info(`   Language: ${language}`);

      await transcribeAudio({
        audioPath: OUTPUT_WAV,
        speechStartsAtSecond,
        language,
        captionOffsetInSeconds: DEFAULT_CAPTION_OFFSET_SECONDS,
      });
    });
    timings.push(timing);
    console.info(`   \u23f1  Transcribe done in ${formatDuration(timing.ms)}`);
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

  console.info(`\n\ud83c\udfa5 Step \u2014 Render`);
  {
    const { timing } = await timed("Render", () =>
      renderPhone(titleText, renderOutput),
    );
    timings.push(timing);
    console.info(`   \u23f1  Render done in ${formatDuration(timing.ms)}`);
  }

  console.info(`\n\ud83d\udce4 Step \u2014 Upload to Telegram`);
  let sentLabel = "Telegram DM";
  {
    const { result, timing } = await timed("Telegram", () =>
      uploadVideoToTelegram({
        filePath: renderOutput,
        caption: titleText,
        telegramTopicId: meta.telegramTopicId,
      }),
    );
    timings.push(timing);
    sentLabel =
      result.messageThreadId != null
        ? `Telegram topic ${result.messageThreadId}`
        : "Telegram DM";
    console.info(`   \u23f1  Telegram done in ${formatDuration(timing.ms)}`);
  }

  console.log("\n\u2705 Done.");
  console.log(`   Client:  ${meta.clientFullName}`);
  console.log(`   Podcast: ${meta.podcastTitle}`);
  console.log(`   Video:   ${renderOutput}`);
  console.log(`   Sent:    ${sentLabel}`);
}

async function runPodcast(mode: Mode = "full") {
  console.log(`\ud83c\udfa4  Podcast pipeline (mode: ${mode})\n`);

  const pipelineStart = performance.now();
  const timings: StepTiming[] = [];

  if (mode === "app") {
    // Phase 1 (PREV-751): public compressed audio for app.jsjoe.io.
    // After publish: optional admin callback (PREV-775), then Telegram unless skipped.
    const { meta, metaKey } = await stepDownloadConvert(timings);
    let publicUrl: string | undefined;
    {
      const { result, timing } = await timed("Publish", () =>
        publishEnhancedAudioForApp(),
      );
      timings.push(timing);
      console.info(`   \u23f1  Publish done in ${formatDuration(timing.ms)}`);
      publicUrl = result.publicUrl;
      if (publicUrl) {
        console.log(`\n\ud83d\udd17 Share this URL in program compose: ${publicUrl}`);
      }
    }
    if (publicUrl) {
      console.info(`\n\ud83d\udce1 Step \u2014 Admin callback`);
      {
        const { timing } = await timed("Admin callback", () =>
          notifyAdminPodcastReady({
            jobId: process.env.PODCAST_JOB_ID?.trim() || null,
            publicUrl,
            clientId: meta.clientId ?? null,
            clientKey: meta.clientKey,
            clientFullName: meta.clientFullName,
            podcastTitle: meta.podcastTitle,
            metaKey,
          }),
        );
        timings.push(timing);
        console.info(
          `   \u23f1  Admin callback done in ${formatDuration(timing.ms)}`,
        );
      }

      const skipTelegram = isTruthyEnv(process.env.SKIP_TELEGRAM);
      if (skipTelegram) {
        console.info(
          `\n\u23ed  Skipping Telegram (SKIP_TELEGRAM=${process.env.SKIP_TELEGRAM})`,
        );
        console.log(`\n\u2705 Done.`);
        console.log(`   Client:  ${meta.clientFullName}`);
        console.log(`   Podcast: ${meta.podcastTitle}`);
        console.log(`   URL:     ${publicUrl}`);
        console.log(`   Sent:    skipped (Telegram)`);
      } else {
        console.info(`\n\ud83d\udce4 Step \u2014 Telegram link`);
        {
          const { result, timing } = await timed("Telegram", () =>
            sendPublicAudioLinkToTelegram({
              publicUrl,
              meta,
            }),
          );
          timings.push(timing);
          const sentLabel =
            result.messageThreadId != null
              ? `Telegram topic ${result.messageThreadId}`
              : "Telegram DM";
          console.info(`   \u23f1  Telegram done in ${formatDuration(timing.ms)}`);
          console.log(`\n\u2705 Done.`);
          console.log(`   Client:  ${meta.clientFullName}`);
          console.log(`   Podcast: ${meta.podcastTitle}`);
          console.log(`   URL:     ${publicUrl}`);
          console.log(`   Sent:    ${sentLabel}`);
        }
      }
    }
    printTimingSummary(timings, performance.now() - pipelineStart);
    return;
  }

  if (mode === "prepare") {
    await stepDownloadConvert(timings);

    // Same speech-start trim as local transcribe: Whisper gets a clean clip;
    // srt-to-captions shifts SRT times back onto the full dialogue.wav timeline.
    console.info(`\n\u2702\ufe0f  Step \u2014 Prepare Whisper input (detect speech + trim)`);
    {
      const { result, timing } = await timed("Whisper prep", async () => {
        const { speechStartsAtSecond, whisperInputPath } =
          await prepareWhisperInput(OUTPUT_WAV);
        console.info(`   \u2192 Speech begins at ${speechStartsAtSecond}s`);
        console.info(`   \u2192 Whisper input: ${whisperInputPath}`);
        return { speechStartsAtSecond, whisperInputPath };
      });
      timings.push(timing);
      console.info(
        `   \u23f1  Whisper prep done in ${formatDuration(timing.ms)} (speech @ ${result.speechStartsAtSecond}s)`,
      );
    }

    const totalMs = performance.now() - pipelineStart;
    console.log("\n\u2705 Prepare done (audio ready for Whisper).");
    console.log(`   Raw WAV (debug):       ${RAW_WAV}`);
    console.log(`   Full WAV (Remotion):   ${OUTPUT_WAV}`);
    console.log(`   Whisper WAV (trimmed): ${WHISPER_INPUT_WAV}`);
    printTimingSummary(timings, totalMs);
    return;
  }

  if (mode === "finish") {
    const meta = loadCachedPodcastMeta();
    const titleText = `${meta.clientFullName} - ${meta.podcastTitle}`;
    const renderOutput = resolveOutputPath(meta);
    console.log("\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    console.log(`Client:   ${meta.clientKey} (${meta.clientFullName})`);
    console.log(`Title:    ${meta.podcastTitle}`);
    console.log(`Captions: ${CAPTIONS_JSON}`);
    console.log(`Output:   ${renderOutput}`);
    console.log("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");
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
    console.error("\n\u274c Podcast pipeline failed:");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { runPodcast };
