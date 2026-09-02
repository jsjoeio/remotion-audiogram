import { execSync } from "child_process";
import fs from "fs";
import path from "path";

/**
 * Podcast loudness chain (PREV-722).
 *
 * AirPods voice notes are thin and quiet. Remotion only plays audio, so we
 * process the full WAV in podcast:prepare *before* the Whisper trim.
 *
 * Chain (mono 48 kHz, single-pass loudnorm):
 *   highpass 80 Hz
 *   EQ: -2 dB @ 180 Hz, +2.5 dB @ 3.2 kHz (presence), -3 dB @ 6.5 kHz (cheap de-ess)
 *   light compressor + limiter
 *   loudnorm → ~−16 LUFS, TP −1.5 dBTP
 *
 * Denoise is optional and off by default (AirPods already gate). Set
 * PODCAST_DENOISE=afftdn|arnndn|off. For arnndn, put the model at
 * models/cb.rnnn (or PODCAST_ARNNDN_MODEL) — same models/ cache as Whisper.
 *
 * Needs *system* ffmpeg. Remotion's binary disables most filters.
 */

const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_ARNNDN_MODEL = path.join("models", "cb.rnnn");

/** acompressor.threshold is linear 0–1, not dB. −22 dB = 10^(−22/20). */
const COMPRESSOR_THRESHOLD_LINEAR = Number((10 ** (-22 / 20)).toFixed(5));

export type DenoiseMode = "off" | "afftdn" | "arnndn";

export interface EnhanceAudioOptions {
  inputPath: string;
  outputPath: string;
  sampleRate?: number;
  denoise?: DenoiseMode;
  arnndnModelPath?: string;
}

function isPcmWav(filePath: string): boolean {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = new Uint8Array(12);
    fs.readSync(fd, header, 0, 12, 0);
    const magic = String.fromCharCode(
      ...header.slice(0, 4),
      ...header.slice(8, 12),
    );
    return magic.startsWith("RIFF") && magic.endsWith("WAVE");
  } finally {
    fs.closeSync(fd);
  }
}

function hasSystemFfmpegOnPath(): boolean {
  try {
    execSync("ffmpeg -hide_banner -version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Prefer FFMPEG_PATH, then `ffmpeg` on PATH. Never fall back to Remotion's binary. */
function resolveSystemFfmpeg(): string {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new Error(`FFMPEG_PATH does not exist: ${fromEnv}`);
    }
    return fromEnv;
  }

  if (hasSystemFfmpegOnPath()) {
    return "ffmpeg";
  }

  throw new Error(
    "System ffmpeg is required for podcast loudness (highpass, equalizer, acompressor, alimiter). Remotion's ffmpeg does not include those filters. Install: sudo apt-get install -y ffmpeg",
  );
}

export function parseDenoiseMode(
  raw: string | undefined = process.env.PODCAST_DENOISE,
): DenoiseMode {
  const value = (raw ?? "off").trim().toLowerCase();
  if (value === "" || value === "off" || value === "0" || value === "false") {
    return "off";
  }
  if (value === "afftdn" || value === "arnndn") {
    return value;
  }
  throw new Error(
    `Invalid PODCAST_DENOISE="${raw}". Use afftdn, arnndn, or off (default).`,
  );
}

export function buildEnhanceFiltergraph(options: {
  denoise?: DenoiseMode;
  arnndnModelPath?: string;
}): string {
  const denoise = options.denoise ?? "off";
  // Float through the EQ/compressor so 16-bit PCM does not clip mid-chain;
  // pcm_s16le at encode time is the last conversion.
  const filters: string[] = ["aformat=sample_fmts=fltp", "highpass=f=80"];

  if (denoise === "afftdn") {
    // Light reduction so speech does not go hollow / "radio AM".
    filters.push("afftdn=nr=6");
  } else if (denoise === "arnndn") {
    const modelPath = options.arnndnModelPath ?? DEFAULT_ARNNDN_MODEL;
    const escaped = modelPath.replaceAll("\\", "/").replaceAll(":", "\\:");
    filters.push(`arnndn=m=${escaped}`);
  }

  filters.push(
    "equalizer=f=180:t=q:w=1.2:g=-2",
    "equalizer=f=3200:t=q:w=1.4:g=2.5",
    "equalizer=f=6500:t=q:w=2:g=-3",
    `acompressor=threshold=${COMPRESSOR_THRESHOLD_LINEAR}:ratio=3:attack=8:release=180:makeup=3`,
    "alimiter=limit=0.95:attack=5:release=50",
    "loudnorm=I=-16:TP=-1.5:LRA=9:dual_mono=true:print_format=summary",
  );

  return filters.join(",");
}

async function enhanceAudio(options: EnhanceAudioOptions) {
  const {
    inputPath,
    outputPath,
    sampleRate = DEFAULT_SAMPLE_RATE,
    denoise = parseDenoiseMode(),
    arnndnModelPath = process.env.PODCAST_ARNNDN_MODEL?.trim() ||
      DEFAULT_ARNNDN_MODEL,
  } = options;

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file does not exist: ${inputPath}`);
  }

  if (denoise === "arnndn" && !fs.existsSync(arnndnModelPath)) {
    throw new Error(
      `PODCAST_DENOISE=arnndn needs a model file at ${arnndnModelPath}. Download cb.rnnn into models/ (cached like Whisper ggml) or set PODCAST_ARNNDN_MODEL. Leave denoise off (default) to skip.`,
    );
  }

  const ffmpegBin = resolveSystemFfmpeg();
  const filtergraph = buildEnhanceFiltergraph({ denoise, arnndnModelPath });

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const replaceInPlace = path.resolve(inputPath) === path.resolve(outputPath);
  const ffmpegOutputPath = replaceInPlace
    ? path.join(
        outputDir,
        `${path.basename(outputPath, path.extname(outputPath))}.enhancing.wav`,
      )
    : outputPath;

  console.info(
    `Enhancing ${inputPath} → ${outputPath} (denoise=${denoise}, ${sampleRate} Hz mono)`,
  );
  console.info(`   ffmpeg: ${ffmpegBin}`);
  console.info(`   chain:  ${filtergraph}`);

  try {
    execSync(
      `"${ffmpegBin}" -y -i "${inputPath}" -af "${filtergraph}" -ar ${sampleRate} -ac 1 -c:a pcm_s16le "${ffmpegOutputPath}"`,
      { stdio: "inherit" },
    );

    if (!isPcmWav(ffmpegOutputPath)) {
      throw new Error(
        `Enhance failed: ${ffmpegOutputPath} is not a valid PCM WAV file.`,
      );
    }

    if (replaceInPlace) {
      fs.renameSync(ffmpegOutputPath, outputPath);
    }
  } catch (error) {
    if (fs.existsSync(ffmpegOutputPath) && ffmpegOutputPath !== outputPath) {
      fs.unlinkSync(ffmpegOutputPath);
    }
    throw error;
  }

  console.info(`Done. Podcast-loudness audio: ${outputPath}`);
  return { inputPath, outputPath, denoise, filtergraph };
}

if (require.main === module) {
  const inputPath = process.argv[2] ?? "./public/dialogue.raw.wav";
  const outputPath = process.argv[3] ?? "./public/dialogue.wav";
  enhanceAudio({ inputPath, outputPath }).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export {
  enhanceAudio,
  resolveSystemFfmpeg,
  hasSystemFfmpegOnPath,
  DEFAULT_ARNNDN_MODEL,
  COMPRESSOR_THRESHOLD_LINEAR,
};
