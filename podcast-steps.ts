import fs from "fs";
import type { Language } from "@remotion/install-whisper-cpp";
import { convertAudio } from "./convert-audio";
import { enhanceAudio } from "./enhance-audio";
import { fetchLatestPodcastJob, type PodcastMeta } from "./r2-podcast";
import {
  detectSpeechStart,
  prepareWhisperInput,
  transcribeAudio,
  WHISPER_INPUT_WAV,
} from "./transcribe";
import { uploadVideoToTelegram } from "./upload-telegram";
import {
  CAPTIONS_JSON,
  DEFAULT_CAPTION_OFFSET_SECONDS,
  DEFAULT_SAMPLE_RATE,
  OUTPUT_WAV,
  PUBLIC_DIR,
  RAW_WAV,
  formatDuration,
  renderPhone,
  resolveLanguage,
  resolveOutputPath,
  timed,
  type StepTiming,
} from "./podcast-shared";

export async function stepDownloadConvert(timings: StepTiming[]) {
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
        outputPath: RAW_WAV,
        sampleRate: DEFAULT_SAMPLE_RATE,
      }),
    );
    timings.push(timing);
    console.info(`   ⏱  Convert done in ${formatDuration(timing.ms)}`);
  }

  // Enhance the full WAV before Whisper trim / Remotion / public AAC.
  console.info(`\n🎚  Step — Enhance audio (podcast loudness)`);
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
    console.info(`   ⏱  Enhance done in ${formatDuration(timing.ms)}`);
  }

  return { meta, metaKey, language, titleText, renderOutput };
}

export async function stepTranscribeLocal(
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

export async function stepRenderUpload(
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
    console.info(`   ⏱  Telegram done in ${formatDuration(timing.ms)}`);
  }

  console.log("\n✅ Done.");
  console.log(`   Client:  ${meta.clientFullName}`);
  console.log(`   Podcast: ${meta.podcastTitle}`);
  console.log(`   Video:   ${renderOutput}`);
  console.log(`   Sent:    ${sentLabel}`);
}

export { WHISPER_INPUT_WAV, prepareWhisperInput };
