import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildEnhanceFiltergraph,
  COMPRESSOR_THRESHOLD_LINEAR,
  enhanceAudio,
  hasSystemFfmpegOnPath,
  parseDenoiseMode,
} from "./enhance-audio";

describe("parseDenoiseMode", () => {
  test("defaults to off", () => {
    expect(parseDenoiseMode(undefined)).toBe("off");
    expect(parseDenoiseMode("")).toBe("off");
    expect(parseDenoiseMode("OFF")).toBe("off");
    expect(parseDenoiseMode("false")).toBe("off");
  });

  test("accepts afftdn and arnndn", () => {
    expect(parseDenoiseMode("afftdn")).toBe("afftdn");
    expect(parseDenoiseMode("ARNNDN")).toBe("arnndn");
  });

  test("rejects unknown values", () => {
    expect(() => parseDenoiseMode("deepfilternet")).toThrow(
      /Invalid PODCAST_DENOISE/,
    );
  });
});

describe("buildEnhanceFiltergraph", () => {
  test("v1 chain: highpass, presence EQ, cheap de-ess, compressor, limiter, loudnorm", () => {
    const graph = buildEnhanceFiltergraph({ denoise: "off" });

    expect(graph.startsWith("aformat=sample_fmts=fltp,highpass=f=80,")).toBe(
      true,
    );
    expect(graph).toContain("equalizer=f=180:t=q:w=1.2:g=-2");
    expect(graph).toContain("equalizer=f=3200:t=q:w=1.4:g=2.5");
    expect(graph).toContain("equalizer=f=6500:t=q:w=2:g=-3");
    expect(graph).toContain(
      `acompressor=threshold=${COMPRESSOR_THRESHOLD_LINEAR}:ratio=3:attack=8:release=180:makeup=3`,
    );
    expect(graph).toContain("alimiter=limit=0.95:attack=5:release=50");
    expect(graph).toContain(
      "loudnorm=I=-16:TP=-1.5:LRA=9:dual_mono=true:print_format=summary",
    );
    expect(graph).not.toContain("afftdn");
    expect(graph).not.toContain("arnndn");
  });

  test("compressor threshold is −22 dB as linear gain", () => {
    expect(COMPRESSOR_THRESHOLD_LINEAR).toBeCloseTo(10 ** (-22 / 20), 5);
    expect(COMPRESSOR_THRESHOLD_LINEAR).toBeGreaterThan(0);
    expect(COMPRESSOR_THRESHOLD_LINEAR).toBeLessThan(1);
  });

  test("afftdn inserts a light denoise after highpass", () => {
    const graph = buildEnhanceFiltergraph({ denoise: "afftdn" });
    expect(
      graph.startsWith("aformat=sample_fmts=fltp,highpass=f=80,afftdn=nr=6,"),
    ).toBe(true);
  });

  test("arnndn points at the model path", () => {
    const graph = buildEnhanceFiltergraph({
      denoise: "arnndn",
      arnndnModelPath: "models/cb.rnnn",
    });
    expect(
      graph.startsWith(
        "aformat=sample_fmts=fltp,highpass=f=80,arnndn=m=models/cb.rnnn,",
      ),
    ).toBe(true);
  });
});

function writeSineWav(
  filePath: string,
  opts: {
    durationSec: number;
    sampleRate: number;
    hz: number;
    amplitude: number;
  },
) {
  const n = Math.floor(opts.durationSec * opts.sampleRate);
  const dataSize = n * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, opts.sampleRate, true);
  view.setUint32(28, opts.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i++) {
    const sample = Math.round(
      opts.amplitude *
        32767 *
        Math.sin((2 * Math.PI * opts.hz * i) / opts.sampleRate),
    );
    view.setInt16(44 + i * 2, sample, true);
  }
  fs.writeFileSync(filePath, bytes);
}

const canRunFfmpeg =
  hasSystemFfmpegOnPath() || Boolean(process.env.FFMPEG_PATH?.trim());

describe("enhanceAudio", () => {
  test.skipIf(!canRunFfmpeg)(
    "writes a PCM WAV from a quiet sine (system ffmpeg)",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enhance-audio-"));
      const inputPath = path.join(dir, "quiet.wav");
      const outputPath = path.join(dir, "loud.wav");
      try {
        writeSineWav(inputPath, {
          durationSec: 8,
          sampleRate: 48_000,
          hz: 440,
          amplitude: 0.04,
        });
        const result = await enhanceAudio({
          inputPath,
          outputPath,
          denoise: "off",
        });
        expect(fs.existsSync(outputPath)).toBe(true);
        expect(fs.statSync(outputPath).size).toBeGreaterThan(44);
        expect(result.denoise).toBe("off");
        expect(result.filtergraph).toContain("loudnorm=I=-16");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("arnndn without a model file fails before ffmpeg", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enhance-audio-"));
    const inputPath = path.join(dir, "quiet.wav");
    try {
      writeSineWav(inputPath, {
        durationSec: 1,
        sampleRate: 48_000,
        hz: 440,
        amplitude: 0.04,
      });
      await expect(
        enhanceAudio({
          inputPath,
          outputPath: path.join(dir, "out.wav"),
          denoise: "arnndn",
          arnndnModelPath: path.join(dir, "missing.rnnn"),
        }),
      ).rejects.toThrow(/needs a model file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
