import fs from "fs";
import * as readline from "readline";
import { shiftCaptions } from "./transcribe";

const DEFAULT_CAPTIONS_PATH = "./public/captions.json";

interface ShiftOptions {
  captionsPath: string;
  offsetSeconds: number;
}

async function askQuestions(rl: readline.Interface): Promise<ShiftOptions> {
  const question = (query: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(query, resolve);
    });
  };

  const captionsPath =
    (await question(
      `❓ Path to captions file (default: ${DEFAULT_CAPTIONS_PATH}): `,
    )) || DEFAULT_CAPTIONS_PATH;

  const offsetStr = await question(
    `❓ Offset to apply to all caption timings in seconds (negative advances text e.g. -0.12 if text is behind): `,
  );
  const offsetSeconds = offsetStr ? parseFloat(offsetStr) : 0;

  return {
    captionsPath,
    offsetSeconds,
  };
}

async function shiftCaptionsFile(options: ShiftOptions) {
  const { captionsPath, offsetSeconds } = options;

  if (!fs.existsSync(captionsPath)) {
    throw new Error(`Captions file not found: ${captionsPath}`);
  }

  const raw = fs.readFileSync(captionsPath, "utf-8");
  const captions = JSON.parse(raw);

  if (!Array.isArray(captions)) {
    throw new Error("Captions file must contain a JSON array of caption objects.");
  }

  const beforeFirst = captions[0]?.startMs ?? null;

  const shifted = shiftCaptions(captions, offsetSeconds);

  fs.writeFileSync(captionsPath, JSON.stringify(shifted, null, 2));

  const afterFirst = shifted[0]?.startMs ?? null;

  console.info(
    `✅ Shifted ${captions.length} captions by ${offsetSeconds}s (${offsetSeconds * 1000}ms).`,
  );
  if (beforeFirst != null && afterFirst != null) {
    console.info(
      `   First caption start moved from ${beforeFirst}ms to ${afterFirst}ms.`,
    );
  }
  console.info(`   Saved to ${captionsPath}`);
}

async function startShiftCaptions() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const options = await askQuestions(rl);
    if (options.offsetSeconds === 0) {
      console.info("Offset is 0 — nothing to do.");
      return;
    }
    await shiftCaptionsFile(options);
  } finally {
    rl.close();
  }
}

// Also support simple CLI usage: bun shift-captions.ts -0.15 [captions.json]
if (require.main === module) {
  const arg = process.argv[2];
  const maybePath = process.argv[3];

  if (arg && !isNaN(parseFloat(arg))) {
    // Non-interactive fast path
    const offsetSeconds = parseFloat(arg);
    const captionsPath = maybePath || DEFAULT_CAPTIONS_PATH;

    shiftCaptionsFile({ captionsPath, offsetSeconds }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    startShiftCaptions();
  }
}

export { shiftCaptionsFile };