import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import * as readline from "readline";

const DEFAULT_INPUT_PATH = "./public/dialogue.wav";
const DEFAULT_SAMPLE_RATE = 48_000;

interface ConvertAudioOptions {
  inputPath: string;
  outputPath: string;
  sampleRate: number;
}

function isPcmWav(filePath: string): boolean {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = new Uint8Array(12);
    fs.readSync(fd, header, 0, 12, 0);
    const magic = String.fromCharCode(...header.slice(0, 4), ...header.slice(8, 12));
    return magic.startsWith("RIFF") && magic.endsWith("WAVE");
  } finally {
    fs.closeSync(fd);
  }
}

function detectFormat(filePath: string): string {
  try {
    const output = execSync(
      `npx remotion ffprobe -v error -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: "utf-8" },
    ).trim();
    return output || "unknown";
  } catch {
    return "unknown";
  }
}

function backupOriginal(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const stem = path.basename(inputPath, path.extname(inputPath));
  const backupPath = path.join(dir, `${stem}-original${path.extname(inputPath)}`);

  if (fs.existsSync(backupPath)) {
    return backupPath;
  }

  fs.copyFileSync(inputPath, backupPath);
  return backupPath;
}

async function askQuestions(
  rl: readline.Interface,
): Promise<ConvertAudioOptions> {
  const question = (query: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(query, resolve);
    });
  };

  const inputPath =
    (await question(
      `❓ Path to audio file (default: ${DEFAULT_INPUT_PATH}): `,
    )) || DEFAULT_INPUT_PATH;

  const outputPath =
    (await question(
      `❓ Output WAV path (default: same as input, replaces in place): `,
    )) || inputPath;

  const sampleRateStr = await question(
    `❓ Sample rate in Hz (default: ${DEFAULT_SAMPLE_RATE}): `,
  );
  const sampleRate = sampleRateStr
    ? parseInt(sampleRateStr, 10)
    : DEFAULT_SAMPLE_RATE;

  return { inputPath, outputPath, sampleRate };
}

async function convertAudio(options: ConvertAudioOptions) {
  const { inputPath, outputPath, sampleRate } = options;

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file does not exist: ${inputPath}`);
  }

  const format = detectFormat(inputPath);
  const alreadyPcmWav = isPcmWav(inputPath);

  if (alreadyPcmWav && inputPath === outputPath) {
    console.info(
      `Already a PCM WAV file (${format}). No conversion needed for Remotion.`,
    );
    return { inputPath, outputPath, converted: false };
  }

  if (inputPath === outputPath) {
    const backupPath = backupOriginal(inputPath);
    console.info(`Backed up original to ${backupPath}`);
  }

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.info(
    `Converting ${inputPath} (${format}) → ${outputPath} (${sampleRate} Hz mono PCM WAV)`,
  );

  execSync(
    `npx remotion ffmpeg -i "${inputPath}" -ar ${sampleRate} -ac 1 -c:a pcm_s16le "${outputPath}" -y`,
    { stdio: "inherit" },
  );

  if (!isPcmWav(outputPath)) {
    throw new Error(`Conversion failed: ${outputPath} is not a valid PCM WAV file.`);
  }

  console.info(`Done. Remotion-ready audio: ${outputPath}`);

  return { inputPath, outputPath, converted: true };
}

async function startConvertAudio() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const options = await askQuestions(rl);
    await convertAudio(options);
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  startConvertAudio();
}

export { convertAudio, type ConvertAudioOptions };