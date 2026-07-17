# Audiogram POC

Turn podcast clips (or any audio) into shareable square videos with captions and a spectrum visualizer.

```bash
bun install
bun run dev          # Remotion Studio
```

**Privacy:** `public/` is gitignored — audio, captions, and cover stay local.

---

## Workflow: Telegram audio → video

The template expects `public/dialogue.wav` (see `src/Root.tsx`). Telegram downloads are usually Opus-in-Ogg even if named `.wav`.

| Step | Command | Notes |
| --- | --- | --- |
| 1. Download | — | Save to `public/dialogue.wav` (or `.ogg`) |
| 2. Convert | `bun run convert-audio` | Backs up original, writes real PCM WAV. Verify: `file public/dialogue.wav` → `WAVE audio` |
| 3. Transcribe | `bun run transcribe` | First run installs whisper.cpp + ~1.5 GB model. Output: `public/captions.json` |
| 4. Preview | `bun run dev` | Tweak props in Studio sidebar or `src/Root.tsx` |
| 5. Render | `bun run render:phone` | Small file, iMessage-safe (see below) |

**Transcribe prompts:** audio path (Enter for default), speech start (auto-detected), language (`auto` or `es`), optional sync offset.

**Linux/WSL first-time transcribe:**

```bash
sudo apt update && sudo apt install -y build-essential cmake
```

**Caption timing tweaks (no re-transcribe):**

```bash
bun run shift-captions -0.12   # advance text 120ms
```

---

## Rendering

### Phone / iMessage (recommended)

```bash
bun run render:phone
```

Output: `out/audiogram-phone.mp4` — targets **~20–22 MB for a 10-min video**, regardless of CRF luck.

Uses **bitrate caps** instead of CRF:

| Setting | Value | Role |
| --- | --- | --- |
| `--video-bitrate` | `200k` | Caps video size (~15 MB / 10 min) |
| `--audio-bitrate` | `96k` | Speech is fine at 96k (~0.7 MB / 10 min) |

**Why bitrate over CRF?** CRF is quality-relative — same setting can yield 42 MB or 67 MB depending on motion/complexity. Bitrate gives a predictable ceiling:

```
approx MB ≈ (video_kbps + audio_kbps) × duration_sec ÷ 8192
```

Examples at `200k + 96k` (296 kbps total):

| Duration | ~File size |
| --- | --- |
| 5 min | ~11 MB |
| 10 min | ~22 MB |
| 15 min | ~33 MB |

Still too big? Lower video bitrate: `--video-bitrate=150k` (~17 MB / 10 min). Too soft? Try `250k` (~25 MB / 10 min).

### Full quality

```bash
bun run render
```

Uses `--crf=28` (H.264 from config). Larger files, better quality.

---

## Captions

Generate with `bun run transcribe`, or supply `.json` in [`@remotion/captions`](https://remotion.dev/docs/captions/caption) format (or `.srt` segmented by word).

---

## Long audio

Use a `.wav` source so the template can window-fetch waveform data instead of loading the whole file.

---

## Docs & help

- [Remotion fundamentals](https://www.remotion.dev/docs/the-fundamentals)
- [Encoding guide](https://www.remotion.dev/docs/encoding)
- [Discord](https://discord.gg/6VzzNDwUwV)