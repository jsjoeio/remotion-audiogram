/**
 * Encode enhanced WAV → AAC (m4a) for app.jsjoe.io playback, then upload to
 * the public R2 bucket (wellness-program-audio by default).
 *
 * Env:
 *   PUBLIC_AUDIO_BUCKET     (default: wellness-program-audio)
 *   PUBLIC_AUDIO_BASE_URL   required for printing a client-ready HTTPS URL
 *                           e.g. https://pub-….r2.dev  or  https://audio.jsjoe.io
 *   PUBLIC_AUDIO_BITRATE    (default: 96k) — speech-friendly AAC
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — same as prepare (wrangler put)
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import {
  loadCachedPodcastMeta,
  slugifyFilename,
  type PodcastMeta,
} from "./r2-podcast";

const PUBLIC_DIR = "./public";
const INPUT_WAV = path.join(PUBLIC_DIR, "dialogue.wav");
const DEFAULT_BUCKET = "wellness-program-audio";
const DEFAULT_BITRATE = "96k";

export type PublishResult = {
  localPath: string;
  objectKey: string;
  bucket: string;
  publicUrl: string | null;
};

function requireSystemFfmpeg(): string {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
    return "ffmpeg";
  } catch {
    throw new Error(
      "System ffmpeg not found. Install ffmpeg (CI: apt-get install ffmpeg).",
    );
  }
}

/** AAC in .m4a — good mobile/Safari support, ~0.7 MB/min at 96k. */
export function encodeAacFromWav(options: {
  inputPath: string;
  outputPath: string;
  bitrate?: string;
}): void {
  const ffmpeg = requireSystemFfmpeg();
  const bitrate = options.bitrate ?? process.env.PUBLIC_AUDIO_BITRATE?.trim() ?? DEFAULT_BITRATE;
  const outDir = path.dirname(options.outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  if (fs.existsSync(options.outputPath)) {
    fs.unlinkSync(options.outputPath);
  }

  console.info(`\n🎧 Encode AAC → ${options.outputPath} (${bitrate})`);
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-i",
      options.inputPath,
      "-vn",
      "-c:a",
      "aac",
      "-b:a",
      bitrate,
      "-movflags",
      "+faststart",
      options.outputPath,
    ],
    { stdio: "inherit" },
  );

  if (!fs.existsSync(options.outputPath)) {
    throw new Error(`ffmpeg finished but missing: ${options.outputPath}`);
  }
  const bytes = fs.statSync(options.outputPath).size;
  console.info(`   Size: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

export function uploadPublicR2Object(options: {
  bucket: string;
  objectKey: string;
  filePath: string;
  contentType: string;
}): void {
  const objectPath = `${options.bucket}/${options.objectKey}`;
  console.info(`\n☁  Upload → r2://${objectPath}`);
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      objectPath,
      "--remote",
      "--file",
      options.filePath,
      "--content-type",
      options.contentType,
    ],
    { stdio: "inherit" },
  );
}

function publicUrlFor(baseUrl: string | undefined, objectKey: string): string | null {
  const base = baseUrl?.trim().replace(/\/$/, "");
  if (!base) return null;
  return `${base}/${objectKey}`;
}

export function resolvePublicObjectKey(meta: PodcastMeta): string {
  const day = (meta.createdAt || new Date().toISOString()).slice(0, 10);
  const slug = slugifyFilename(meta.clientKey || meta.clientFullName, meta.podcastTitle);
  return `program/${meta.clientKey || "client"}/${day}-${slug}.m4a`;
}

/**
 * Encode dialogue.wav → m4a and upload to the public bucket.
 * Expects podcast:prepare (or equivalent) to have written dialogue.wav + cached meta.
 */
export async function publishEnhancedAudioForApp(): Promise<PublishResult> {
  if (!fs.existsSync(INPUT_WAV)) {
    throw new Error(
      `Missing ${INPUT_WAV}. Run \`bun run podcast:prepare\` (or podcast:app prepare) first.`,
    );
  }

  const meta = loadCachedPodcastMeta();
  const bucket =
    process.env.PUBLIC_AUDIO_BUCKET?.trim() || DEFAULT_BUCKET;
  const objectKey = resolvePublicObjectKey(meta);
  const localPath = path.join(
    PUBLIC_DIR,
    `${slugifyFilename(meta.clientFullName, meta.podcastTitle)}.m4a`,
  );

  encodeAacFromWav({ inputPath: INPUT_WAV, outputPath: localPath });
  uploadPublicR2Object({
    bucket,
    objectKey,
    filePath: localPath,
    contentType: "audio/mp4",
  });

  const publicUrl = publicUrlFor(process.env.PUBLIC_AUDIO_BASE_URL, objectKey);
  console.log("\n✅ Public audio ready");
  console.log(`   Bucket:  ${bucket}`);
  console.log(`   Key:     ${objectKey}`);
  if (publicUrl) {
    console.log(`   URL:     ${publicUrl}`);
  } else {
    console.log(
      "   URL:     (set PUBLIC_AUDIO_BASE_URL to print the client HTTPS link)",
    );
  }

  return { localPath, objectKey, bucket, publicUrl };
}

if (require.main === module) {
  publishEnhancedAudioForApp().catch((err) => {
    console.error("\n❌ publish public audio failed:");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
