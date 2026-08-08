/**
 * Convert an SRT file to Remotion captions.json.
 *
 * Used in CI after appleboy/whisper-action (or any Whisper that emits SRT).
 * Segment-level captions are coarser than local whisper.cpp token timestamps,
 * but Remotion already supports SRT via parseSrt — good enough for CI.
 *
 * When prepare wrote `.cache/speech-start.json` (trimmed Whisper input), times
 * in the SRT are relative to speech start — we shift them back so they match
 * full public/dialogue.wav used by Remotion (same as local transcribe).
 *
 * Usage:
 *   bun srt-to-captions.ts
 *   bun srt-to-captions.ts public/captions.srt public/captions.json
 *   bun srt-to-captions.ts public/captions.srt public/captions.json 1.25
 */

import fs from "fs";
import path from "path";
import { parseSrt, type Caption } from "@remotion/captions";
import { loadSpeechStart, shiftCaptions } from "./transcribe";

const DEFAULT_SRT = path.join("public", "captions.srt");
const DEFAULT_JSON = path.join("public", "captions.json");

/**
 * Split multi-word SRT cues into per-word captions with proportional timing.
 * Improves karaoke-style highlight vs one blob per subtitle line.
 */
function expandToWords(captions: Caption[]): Caption[] {
  const out: Caption[] = [];

  for (const cue of captions) {
    const words = cue.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    if (words.length === 1) {
      out.push({
        ...cue,
        text: words[0]!.startsWith(" ") ? words[0]! : ` ${words[0]}`,
      });
      continue;
    }

    const duration = Math.max(1, cue.endMs - cue.startMs);
    const slice = duration / words.length;

    words.forEach((word, i) => {
      const startMs = Math.round(cue.startMs + slice * i);
      const endMs =
        i === words.length - 1
          ? cue.endMs
          : Math.round(cue.startMs + slice * (i + 1));
      out.push({
        text: i === 0 ? word : ` ${word}`,
        startMs,
        endMs,
        timestampMs: startMs,
        confidence: cue.confidence ?? null,
      });
    });
  }

  return out;
}

function main() {
  const srtPath = process.argv[2] ?? DEFAULT_SRT;
  const jsonPath = process.argv[3] ?? DEFAULT_JSON;
  // Optional 3rd arg: override offset. Else load from prepare's speech-start cache.
  const offsetArg = process.argv[4];
  const offsetSeconds =
    offsetArg != null && offsetArg !== ""
      ? parseFloat(offsetArg)
      : loadSpeechStart();

  if (offsetArg != null && offsetArg !== "" && !Number.isFinite(offsetSeconds)) {
    throw new Error(`Invalid offset seconds: ${offsetArg}`);
  }

  if (!fs.existsSync(srtPath)) {
    throw new Error(`SRT not found: ${srtPath}`);
  }

  const input = fs.readFileSync(srtPath, "utf8");
  const { captions } = parseSrt({ input });

  if (captions.length === 0) {
    throw new Error(`No captions parsed from ${srtPath}`);
  }

  // parseSrt cues are usually full lines; expand for Word.tsx highlighting.
  let wordCaptions = expandToWords(captions);

  if (offsetSeconds !== 0) {
    wordCaptions = shiftCaptions(wordCaptions, offsetSeconds);
    console.info(
      `⏱  Shifted captions by +${offsetSeconds}s (speech-start trim → full audio timeline)`,
    );
  } else {
    console.info("⏱  No speech-start offset (0s) — captions unchanged relative to SRT");
  }

  const dir = path.dirname(jsonPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(jsonPath, JSON.stringify(wordCaptions, null, 2));
  console.info(
    `✅ Wrote ${wordCaptions.length} word captions → ${jsonPath} (from ${captions.length} SRT cues)`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

export { expandToWords };
