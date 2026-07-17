import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import * as readline from "readline";
import type { Language } from "@remotion/install-whisper-cpp";
import { convertAudio } from "./convert-audio";
import { CLIENT_CONFIG } from "./src/clientConfig";
import {
  detectSpeechStart,
  transcribeAudio,
} from "./transcribe";

const PUBLIC_DIR = "./public";
const OUTPUT_WAV = path.join(PUBLIC_DIR, "dialogue.wav");
const RENDER_OUTPUT = "out/audiogram-phone.mp4";
const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_CAPTION_OFFSET_SECONDS = 0;

/** Prefer ogg (Telegram), then common audio formats already in public/. */
const INPUT_CANDIDATES = [
  "dialogue.ogg",
  "dialogue.wav",
  "dialogue.mp3",
  "dialogue.m4a",
  "dialogue.opus",
  "dialogue.webm",
];

type ClientEntry = {
  key: string;
  fullName: string;
  language: Language;
};

function question(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, resolve);
  });
}

function resolveInputAudio(): string {
  for (const name of INPUT_CANDIDATES) {
    const candidate = path.join(PUBLIC_DIR, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `No dialogue audio found in ${PUBLIC_DIR}. Save dialogue.ogg (or .wav) there first.`,
  );
}

function listClients(): ClientEntry[] {
  return Object.entries(CLIENT_CONFIG).map(([key, config]) => ({
    key,
    fullName: config.fullName,
    language: config.language,
  }));
}

async function pickClient(rl: readline.Interface): Promise<ClientEntry> {
  const clients = listClients();

  if (clients.length === 0) {
    throw new Error(
      "No clients in CLIENT_CONFIG. Add one in src/clientConfig.ts first.",
    );
  }

  console.log("\nClients:");
  clients.forEach((client, i) => {
    console.log(
      `  ${i + 1}. ${client.key} (${client.fullName}) [${client.language}]`,
    );
  });

  while (true) {
    const answer = (await question(rl, "\nSelect client number: ")).trim();
    const n = parseInt(answer, 10);

    if (!Number.isNaN(n) && n >= 1 && n <= clients.length) {
      return clients[n - 1]!;
    }

    console.log(`Please enter a number between 1 and ${clients.length}.`);
  }
}

async function askTitle(rl: readline.Interface): Promise<string> {
  while (true) {
    const title = (await question(rl, "Title: ")).trim();
    if (title) {
      return title;
    }
    console.log("Title cannot be empty.");
  }
}

function renderPhone(titleText: string) {
  const propsPath = path.join(
    os.tmpdir(),
    `audiogram-props-${Date.now()}.json`,
  );

  fs.writeFileSync(propsPath, JSON.stringify({ titleText }));

  const outDir = path.dirname(RENDER_OUTPUT);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.info(`\n🎬 Rendering phone video → ${RENDER_OUTPUT}`);
  console.info(`   titleText: ${titleText}`);

  try {
    // Same settings as package.json "render:phone"; title via --props so Root.tsx stays clean.
    execSync(
      `npx remotion render Audiogram "${RENDER_OUTPUT}" --video-bitrate=200k --audio-bitrate=96k --props="${propsPath}"`,
      { stdio: "inherit" },
    );
  } finally {
    if (fs.existsSync(propsPath)) {
      fs.unlinkSync(propsPath);
    }
  }
}

async function runPodcast() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("🎙  Podcast pipeline\n");

    const client = await pickClient(rl);
    const title = await askTitle(rl);
    const titleText = `${client.fullName} - ${title}`;

    console.log("\n────────────────────────────");
    console.log(`Client:   ${client.key} (${client.fullName})`);
    console.log(`Language: ${client.language}`);
    console.log(`Title:    ${titleText}`);
    console.log("────────────────────────────\n");

    // Close stdin prompts before long-running work (ffmpeg / whisper / render).
    rl.close();

    // 1. Convert audio → public/dialogue.wav (defaults: 48kHz mono PCM)
    const inputPath = resolveInputAudio();
    console.info(`\n🔊 Step 1/3 — Convert audio`);
    console.info(`   Input: ${inputPath}`);
    await convertAudio({
      inputPath,
      outputPath: OUTPUT_WAV,
      sampleRate: DEFAULT_SAMPLE_RATE,
    });

    // 2. Transcribe with client language + auto-detected speech start
    console.info(`\n📝 Step 2/3 — Transcribe`);
    console.info(
      "   Detecting when speech begins (ffmpeg silencedetect)...",
    );
    const speechStartsAtSecond = await detectSpeechStart(OUTPUT_WAV);
    console.info(`   → Speech begins at ${speechStartsAtSecond}s`);
    console.info(`   Language: ${client.language}`);

    await transcribeAudio({
      audioPath: OUTPUT_WAV,
      speechStartsAtSecond,
      language: client.language,
      captionOffsetInSeconds: DEFAULT_CAPTION_OFFSET_SECONDS,
    });

    // 3. Render phone-optimized video with dynamic title (no Root.tsx edit)
    console.info(`\n🎥 Step 3/3 — Render`);
    renderPhone(titleText);

    console.log("\n✅ Done.");
    console.log(`   Video: ${RENDER_OUTPUT}`);
  } catch (error) {
    // Ensure readline is closed on early failure during prompts.
    try {
      rl.close();
    } catch {
      // already closed
    }
    throw error;
  }
}

if (require.main === module) {
  runPodcast().catch((err) => {
    console.error("\n❌ Podcast pipeline failed:");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { runPodcast };
