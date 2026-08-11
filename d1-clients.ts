/**
 * Client roster from Cloudflare D1 (`jsjoeio.clients`).
 *
 * Same source of truth as jsjoe.io telegram-webhook (PR #38).
 * Uses `wrangler d1 execute --remote` (OAuth login or CLOUDFLARE_API_TOKEN).
 */

import { execFileSync } from "child_process";

export type ClientLanguage = "en" | "es";

export type ClientEntry = {
  /** 1-based index in the Telegram numbered list (not necessarily DB id) */
  index: number;
  /** D1 primary key */
  id: number;
  /** Full display name, e.g. "Tim Gailey" */
  fullName: string;
  language: ClientLanguage;
  /**
   * Short label for remotion meta JSON (first word of name).
   * e.g. "Tim Gailey" → "Tim", "Reilly" → "Reilly"
   */
  key: string;
};

/** D1 database name (shared with jsjoe.io). */
export const D1_DATABASE = "jsjoeio";

/** Active + gifted only — completed clients drop out of the picker. */
const LIST_SQL =
  "SELECT id, name, language FROM clients WHERE status IN ('active', 'gifted') ORDER BY id ASC";

type ClientRow = {
  id: number;
  name: string;
  language: string;
};

type D1ExecuteChunk = {
  results?: ClientRow[];
  success?: boolean;
  error?: string;
};

/** First whitespace-separated token of the full name. */
export function shortKeyFromName(name: string): string {
  const token = name.trim().split(/\s+/)[0];
  return token || name.trim();
}

function toLanguage(value: string): ClientLanguage {
  return value === "es" ? "es" : "en";
}

function rowsToEntries(rows: ClientRow[]): ClientEntry[] {
  return rows.map((row, i) => ({
    index: i + 1,
    id: row.id,
    fullName: row.name,
    language: toLanguage(row.language),
    key: shortKeyFromName(row.name),
  }));
}

/**
 * Ordered roster from remote D1 (active + gifted).
 * Requires `npx wrangler login` or CLOUDFLARE_API_TOKEN.
 */
export function listClients(): ClientEntry[] {
  const raw = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      D1_DATABASE,
      "--remote",
      "--json",
      "--command",
      LIST_SQL,
    ],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );

  // wrangler may print a banner before JSON
  const jsonStart = raw.indexOf("[");
  if (jsonStart === -1) {
    throw new Error(
      "Could not parse `wrangler d1 execute --json` output. " +
        "Run `npx wrangler login` or set CLOUDFLARE_API_TOKEN.",
    );
  }

  const parsed = JSON.parse(raw.slice(jsonStart)) as D1ExecuteChunk[];
  const chunk = parsed[0];
  if (!chunk) {
    throw new Error("D1 listClients returned empty result.");
  }
  if (chunk.success === false) {
    throw new Error(
      `D1 listClients query failed: ${chunk.error ?? "unknown error"}`,
    );
  }

  return rowsToEntries(chunk.results ?? []);
}

/** Look up by short key (first word of name), e.g. "Tim". */
export function getClientByKey(key: string): ClientEntry | null {
  const needle = key.trim();
  if (!needle) return null;
  return listClients().find((c) => c.key === needle) ?? null;
}

/** Numbered block (same shape as the Telegram bot list). */
export function formatClientList(clients: ClientEntry[]): string {
  if (clients.length === 0) {
    return "(no active/gifted clients in D1)";
  }
  return clients.map((c) => `${c.index}. ${c.fullName}`).join("\n");
}

// Local check: `bun d1-clients.ts` or `bun run clients`
if (require.main === module) {
  try {
    console.log(`☁  Reading clients from D1 (${D1_DATABASE})…\n`);
    const clients = listClients();
    console.log(`Loaded ${clients.length} client(s):\n`);
    console.log(formatClientList(clients));
    console.log("");
    for (const c of clients) {
      console.log(
        `  key=${c.key.padEnd(10)} language=${c.language}  id=${c.id}`,
      );
    }
    console.log("\n✅ D1 clients OK");
  } catch (err) {
    console.error("\n❌ Failed to read clients from D1:");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
