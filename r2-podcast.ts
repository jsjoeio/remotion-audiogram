/**
 * Pull the latest podcast job from Cloudflare R2 (bucket: telegram-voice).
 *
 * Meta is written by the Telegram bot (jsjoe.io workers/telegram-webhook):
 *   voice/{userId}/{YYYY-MM-DD}/{msgId}-{fileUniqueId}.ogg
 *   meta/voice/{userId}/{YYYY-MM-DD}/{msgId}-{fileUniqueId}.json
 *
 * List uses the Cloudflare REST API (wrangler has no object-list command).
 * Downloads use `wrangler r2 object get --remote`.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export const R2_BUCKET = "telegram-voice";
export const META_PREFIX = "meta/";
export const CACHE_DIR = ".cache";
export const LOCAL_META_PATH = path.join(CACHE_DIR, "latest-podcast-meta.json");

/** Same shape as workers/telegram-webhook/src/meta.ts PodcastMeta */
export type PodcastMeta = {
  clientFullName: string;
  clientKey: string;
  language: "en" | "es";
  podcastTitle: string;
  audioPath: string;
  createdAt: string;
};

type R2ListObject = {
  key?: string;
  last_modified?: string;
  size?: number;
  custom_metadata?: Record<string, string>;
};

type CloudflareListResponse = {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: R2ListObject[];
  result_info?: {
    cursor?: string;
    is_truncated?: boolean;
    per_page?: number;
  };
};

function readWranglerOAuthToken(): string | null {
  const configPath = path.join(
    os.homedir(),
    ".config",
    ".wrangler",
    "config",
    "default.toml",
  );
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const text = fs.readFileSync(configPath, "utf8");
  const match = text.match(/oauth_token\s*=\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

/**
 * Auth for the Cloudflare REST API (list objects).
 * Prefer CLOUDFLARE_API_TOKEN; fall back to wrangler OAuth from local login.
 */
export function getCloudflareApiToken(): string {
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromWrangler = readWranglerOAuthToken();
  if (fromWrangler) {
    return fromWrangler;
  }
  throw new Error(
    "No Cloudflare credentials. Run `npx wrangler login` or set CLOUDFLARE_API_TOKEN.",
  );
}

/** Account id from env or `wrangler whoami --json`. */
export function getCloudflareAccountId(): string {
  const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const raw = execFileSync(
    "npx",
    ["wrangler", "whoami", "--json"],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  // wrangler may print a banner before JSON
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) {
    throw new Error("Could not parse `wrangler whoami --json` output.");
  }
  const parsed = JSON.parse(raw.slice(jsonStart)) as {
    accounts?: Array<{ id: string }>;
  };
  const id = parsed.accounts?.[0]?.id;
  if (!id) {
    throw new Error(
      "No Cloudflare account on this login. Set CLOUDFLARE_ACCOUNT_ID or run `npx wrangler login`.",
    );
  }
  return id;
}

/** List all objects under a prefix (paginated). */
export async function listR2Objects(prefix: string): Promise<R2ListObject[]> {
  const token = getCloudflareApiToken();
  const accountId = getCloudflareAccountId();
  const objects: R2ListObject[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${R2_BUCKET}/objects`,
    );
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("per_page", "1000");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `R2 list failed HTTP ${res.status}: ${body.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as CloudflareListResponse;
    if (!json.success) {
      const msg = json.errors?.map((e) => e.message).join("; ") ?? "unknown";
      throw new Error(`R2 list API error: ${msg}`);
    }

    objects.push(...(json.result ?? []));
    cursor = json.result_info?.is_truncated
      ? json.result_info.cursor
      : undefined;
  } while (cursor);

  return objects;
}

/** Most recently modified object under meta/. */
export async function findLatestMetaObject(): Promise<R2ListObject> {
  const objects = await listR2Objects(META_PREFIX);
  const withKeys = objects.filter((o) => o.key?.endsWith(".json"));

  if (withKeys.length === 0) {
    throw new Error(
      `No podcast metadata in R2 bucket "${R2_BUCKET}" under prefix "${META_PREFIX}". ` +
        "Send a voice note to the Telegram bot and reply with client + title first.",
    );
  }

  withKeys.sort((a, b) => {
    const ta = a.last_modified ? Date.parse(a.last_modified) : 0;
    const tb = b.last_modified ? Date.parse(b.last_modified) : 0;
    return tb - ta;
  });

  return withKeys[0]!;
}

/**
 * Download an R2 object with wrangler CLI → local file.
 * objectPath is the key only (not bucket/key).
 */
export function downloadR2Object(objectKey: string, destPath: string): void {
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const objectPath = `${R2_BUCKET}/${objectKey}`;
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "get",
      objectPath,
      "--remote",
      "--file",
      destPath,
    ],
    { stdio: "inherit" },
  );

  if (!fs.existsSync(destPath)) {
    throw new Error(`wrangler download reported success but missing: ${destPath}`);
  }
}

function parsePodcastMeta(raw: unknown): PodcastMeta {
  if (!raw || typeof raw !== "object") {
    throw new Error("Podcast meta JSON is not an object.");
  }
  const o = raw as Record<string, unknown>;
  const clientFullName = String(o.clientFullName ?? "").trim();
  const clientKey = String(o.clientKey ?? "").trim();
  const podcastTitle = String(o.podcastTitle ?? "").trim();
  const audioPath = String(o.audioPath ?? "").trim();
  const language = o.language === "es" ? "es" : "en";
  const createdAt = String(o.createdAt ?? "");

  if (!clientFullName || !clientKey || !podcastTitle || !audioPath) {
    throw new Error(
      "Podcast meta missing required fields (clientFullName, clientKey, podcastTitle, audioPath).",
    );
  }

  return {
    clientFullName,
    clientKey,
    language,
    podcastTitle,
    audioPath,
    createdAt,
  };
}

export type FetchedPodcastJob = {
  meta: PodcastMeta;
  metaKey: string;
  /** Local path to downloaded audio (e.g. public/dialogue.ogg) */
  audioLocalPath: string;
  /** Local path to cached meta JSON */
  metaLocalPath: string;
};

/**
 * Fetch the latest podcast job from R2:
 * 1. List meta/, pick newest by last_modified
 * 2. Download meta JSON → .cache/latest-podcast-meta.json
 * 3. Download audio → public/dialogue.<ext>
 */
export async function fetchLatestPodcastJob(options?: {
  audioDestDir?: string;
  audioBaseName?: string;
}): Promise<FetchedPodcastJob> {
  const audioDestDir = options?.audioDestDir ?? "./public";
  const audioBaseName = options?.audioBaseName ?? "dialogue";

  console.info(`\n☁  Fetching latest podcast job from R2 (${R2_BUCKET})…`);
  const latest = await findLatestMetaObject();
  const metaKey = latest.key!;
  console.info(`   Meta key: ${metaKey}`);
  if (latest.last_modified) {
    console.info(`   Modified: ${latest.last_modified}`);
  }

  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  downloadR2Object(metaKey, LOCAL_META_PATH);
  const meta = parsePodcastMeta(
    JSON.parse(fs.readFileSync(LOCAL_META_PATH, "utf8")),
  );

  const ext = path.extname(meta.audioPath) || ".ogg";
  const audioLocalPath = path.join(audioDestDir, `${audioBaseName}${ext}`);

  console.info(`   Audio key: ${meta.audioPath}`);
  downloadR2Object(meta.audioPath, audioLocalPath);

  // Keep a copy of the raw audio under .cache for debugging (not git-tracked).
  const cacheAudioPath = path.join(
    CACHE_DIR,
    `audio${ext}`,
  );
  fs.copyFileSync(audioLocalPath, cacheAudioPath);

  return {
    meta,
    metaKey,
    audioLocalPath,
    metaLocalPath: LOCAL_META_PATH,
  };
}

/** Filesystem-safe slug: "Tim Gailey" + "Hola Joe" → "tim-gailey-hola-joe" */
export function slugifyFilename(...parts: string[]): string {
  return parts
    .join("-")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "audiogram";
}
