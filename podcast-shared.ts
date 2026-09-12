import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Language } from "@remotion/install-whisper-cpp";
import { getClientByKey } from "./d1-clients";
import { slugifyFilename, type PodcastMeta } from "./r2-podcast";

export const PUBLIC_DIR = "./public";
/** Unprocessed PCM after convert — kept for A/B debug. */
export const RAW_WAV = path.join(PUBLIC_DIR, "dialogue.raw.wav");
/** Enhanced PCM used by Whisper trim + Remotion / public AAC encode. */
export const OUTPUT_WAV = path.join(PUBLIC_DIR, "dialogue.wav");
export const CAPTIONS_JSON = path.join(PUBLIC_DIR, "captions.json");
export const DEFAULT_SAMPLE_RATE = 48_000;
export const DEFAULT_CAPTION_OFFSET_SECONDS = 0;

export type StepTiming = {
  name: string;
  ms: number;
};

/** CLI modes for podcast.ts */
export type Mode = "full" | "prepare" | "finish" | "app";

/** Human-readable duration, e.g. "842ms", "12.3s", "1m 24s". */
export function formatDuration(ms: number): string {
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

export async function timed<T>(
  name: string,
  fn: () => T | Promise<T>,
): Promise<{ result: T; timing: StepTiming }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { result, timing: { name, ms } };
}

export function printTimingSummary(timings: StepTiming[], totalMs: number) {
  console.log("\n⏱  Timing");
  console.log("────────────────────────────");
  for (const { name, ms } of timings) {
    console.log(`  ${name.padEnd(12)} ${formatDuration(ms)}`);
  }
  console.log("────────────────────────────");
  console.log(`  ${"Total".padEnd(12)} ${formatDuration(totalMs)}`);
}

/** true / 1 / yes (case-insensitive). Empty/absent = false (push triggers). */
export function isTruthyEnv(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Prefer language from D1 clients table (source of truth); fall back to R2 meta.
 * D1 lookup is best-effort so offline / missing wrangler still works with meta.
 */
export function resolveLanguage(meta: PodcastMeta): Language {
  try {
    const fromD1 = getClientByKey(meta.clientKey)?.language;
    if (fromD1) {
      return fromD1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`   ⚠  D1 clients unavailable (${msg}); using meta.language`);
  }
  return meta.language;
}

export function resolveOutputPath(meta: PodcastMeta): string {
  const slug = slugifyFilename(meta.clientFullName, meta.podcastTitle);
  return path.join("out", `${slug}.mp4`);
}

export function renderPhone(titleText: string, renderOutput: string) {
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

export function parseMode(argv: string[]): Mode {
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
