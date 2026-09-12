/**
 * CLI modes:
 *   full     — local: download → enhance → whisper.cpp → render → Telegram
 *   prepare  — CI pre-whisper (includes speech-start trim for Whisper)
 *   finish   — CI post-whisper: render → Telegram
 *   app      — app.jsjoe.io path: download → enhance → AAC → public R2
 *              → optional admin callback + Telegram topic with public URL
 *              (no Whisper / Remotion)
 */
import { publishEnhancedAudioForApp } from "./encode-public-audio";
import { loadCachedPodcastMeta } from "./r2-podcast";
import { notifyAdminPodcastReady } from "./notify-admin-callback";
import { sendPublicAudioLinkToTelegram } from "./notify-telegram-link";
import {
  CAPTIONS_JSON,
  OUTPUT_WAV,
  RAW_WAV,
  formatDuration,
  isTruthyEnv,
  parseMode,
  printTimingSummary,
  resolveOutputPath,
  timed,
  type Mode,
  type StepTiming,
} from "./podcast-shared";
import {
  WHISPER_INPUT_WAV,
  prepareWhisperInput,
  stepDownloadConvert,
  stepRenderUpload,
  stepTranscribeLocal,
} from "./podcast-steps";

async function runPodcast(mode: Mode = "full") {
  console.log(`🎙  Podcast pipeline (mode: ${mode})\n`);

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
      console.info(`   ⏱  Publish done in ${formatDuration(timing.ms)}`);
      publicUrl = result.publicUrl;
      if (publicUrl) {
        console.log(`\n🔗 Share this URL in program compose: ${publicUrl}`);
      }
    }
    if (publicUrl) {
      // Compose path only: avoid failing Telegram-bot runs if callback URL is set
      // before the admin endpoint exists.
      const shouldNotifyAdmin =
        isTruthyEnv(process.env.SKIP_TELEGRAM) ||
        Boolean(process.env.PODCAST_JOB_ID?.trim());

      if (shouldNotifyAdmin) {
        console.info(`\n📡 Step — Admin callback`);
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
            `   ⏱  Admin callback done in ${formatDuration(timing.ms)}`,
          );
        }
      } else {
        console.info(
          `\n⏭  Skipping admin callback (no skip_telegram / job_id — Telegram bot path)`,
        );
      }

      const skipTelegram = isTruthyEnv(process.env.SKIP_TELEGRAM);
      if (skipTelegram) {
        console.info(
          `\n⏭  Skipping Telegram (SKIP_TELEGRAM=${process.env.SKIP_TELEGRAM})`,
        );
        console.log(`\n✅ Done.`);
        console.log(`   Client:  ${meta.clientFullName}`);
        console.log(`   Podcast: ${meta.podcastTitle}`);
        console.log(`   URL:     ${publicUrl}`);
        console.log(`   Sent:    skipped (Telegram)`);
      } else {
        console.info(`\n📤 Step — Telegram link`);
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
          console.info(`   ⏱  Telegram done in ${formatDuration(timing.ms)}`);
          console.log(`\n✅ Done.`);
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
