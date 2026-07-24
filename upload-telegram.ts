/**
 * Send a rendered audiogram MP4 to yourself via the Telegram bot.
 *
 * Same env vars as jsjoe.io workers/telegram-webhook:
 *   TELEGRAM_BOT_TOKEN
 *   ALLOWED_TELEGRAM_USER_ID   (your numeric Telegram user id = chat id for DMs)
 *
 * Usage:
 *   bun run upload-telegram
 *   bun run upload-telegram out/tim-gailey-hola-joe.mp4
 *   bun upload-telegram.ts path/to/video.mp4
 *
 * Loads `.env` / `.env.local` automatically (Bun). Do not commit those files.
 * Also invoked automatically at the end of `bun run podcast`.
 */

import fs from "fs";
import path from "path";

const OUT_DIR = "./out";
/** Telegram Bot API limit for sendVideo / sendDocument (bots). */
const MAX_BYTES = 50 * 1024 * 1024;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in .env (or the environment), same as the telegram-webhook worker:\n` +
        `  TELEGRAM_BOT_TOKEN=...\n` +
        `  ALLOWED_TELEGRAM_USER_ID=...\n` +
        `(copy from jsjoe.io/workers/telegram-webhook/.dev.vars if you have it there)`,
    );
  }
  return value;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Newest .mp4 under out/ by mtime. */
export function findLatestMp4(): string {
  if (!fs.existsSync(OUT_DIR)) {
    throw new Error(`No ${OUT_DIR}/ directory. Render a video first.`);
  }
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.toLowerCase().endsWith(".mp4"))
    .map((f) => {
      const full = path.join(OUT_DIR, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    throw new Error(
      `No .mp4 files in ${OUT_DIR}/. Run the podcast pipeline first.`,
    );
  }
  return files[0]!.full;
}

function resolveVideoPath(argv: string[]): string {
  const arg = argv[2]?.trim();
  if (arg) {
    if (!fs.existsSync(arg)) {
      throw new Error(`File not found: ${arg}`);
    }
    return arg;
  }
  return findLatestMp4();
}

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
  error_code?: number;
  result?: { message_id?: number };
};

export type UploadTelegramResult = {
  method: "sendVideo" | "sendDocument";
  messageId?: number;
  filePath: string;
  bytes: number;
};

/**
 * Prefer sendVideo (inline player on phone). Fall back to sendDocument
 * if Telegram rejects the video (codec/container edge cases).
 */
async function sendViaTelegram(options: {
  token: string;
  chatId: string;
  filePath: string;
  caption: string;
}): Promise<{ method: "sendVideo" | "sendDocument"; messageId?: number }> {
  const { token, chatId, filePath, caption } = options;
  const filename = path.basename(filePath);
  const blob = Bun.file(filePath);

  async function post(
    method: "sendVideo" | "sendDocument",
    field: "video" | "document",
  ): Promise<TelegramApiResponse> {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append(field, blob, filename);
    form.append("caption", caption);
    if (method === "sendVideo") {
      form.append("supports_streaming", "true");
    }

    const res = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      { method: "POST", body: form },
    );
    return (await res.json()) as TelegramApiResponse;
  }

  const videoResult = await post("sendVideo", "video");
  if (videoResult.ok) {
    return { method: "sendVideo", messageId: videoResult.result?.message_id };
  }

  console.warn(
    `   sendVideo failed (${videoResult.error_code ?? "?"}: ${videoResult.description ?? "unknown"}); trying sendDocument…`,
  );

  const docResult = await post("sendDocument", "document");
  if (!docResult.ok) {
    throw new Error(
      `Telegram send failed.\n` +
        `  sendVideo: ${videoResult.description ?? "unknown"}\n` +
        `  sendDocument: ${docResult.description ?? "unknown"}`,
    );
  }

  return { method: "sendDocument", messageId: docResult.result?.message_id };
}

/**
 * Upload an MP4 to your Telegram DM (same bot + user as the webhook worker).
 * Call from the podcast pipeline or via CLI.
 */
export async function uploadVideoToTelegram(options: {
  filePath: string;
  /** Defaults to the file basename without extension */
  caption?: string;
}): Promise<UploadTelegramResult> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const chatId = requireEnv("ALLOWED_TELEGRAM_USER_ID");
  const { filePath } = options;

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (stat.size > MAX_BYTES) {
    throw new Error(
      `File is ${formatBytes(stat.size)} — Telegram bots cap uploads at ~50 MB. ` +
        `Re-render with a lower bitrate or shorter clip.`,
    );
  }

  const caption =
    options.caption?.trim() ||
    path.basename(filePath, path.extname(filePath));

  console.log("📤 Upload to Telegram");
  console.log("────────────────────────────");
  console.log(`  File:    ${filePath}`);
  console.log(`  Size:    ${formatBytes(stat.size)}`);
  console.log(`  Chat:    ${chatId}`);
  console.log(`  Caption: ${caption}`);
  console.log("────────────────────────────\n");

  const { method, messageId } = await sendViaTelegram({
    token,
    chatId,
    filePath,
    caption,
  });

  console.log(
    `✅ Sent via ${method}${messageId != null ? ` (message_id ${messageId})` : ""}`,
  );
  console.log("   Check your DM with the bot on your phone.");

  return { method, messageId, filePath, bytes: stat.size };
}

async function main() {
  const filePath = resolveVideoPath(process.argv);
  await uploadVideoToTelegram({ filePath });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\n❌ Upload failed:");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
