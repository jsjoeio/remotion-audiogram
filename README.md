# Audiogram POC

Turn podcast clips (or any audio) into shareable square videos with captions and a spectrum visualizer.

```bash
bun install
bun run dev          # Remotion Studio
```

**Privacy:** `public/` and `.cache/` are gitignored — audio, captions, cover, and R2 job meta stay local.

---

## Workflow: Telegram → R2 → video

Voice notes go to the Telegram bot ([jsjoe.io](https://github.com/jsjoeio/jsjoe.io) `telegram-webhook`), which stores audio + metadata in R2 (`telegram-voice`). This repo pulls the latest job and renders.

### One-shot pipeline

```bash
npx wrangler login   # once per machine (R2 downloads)
cp .env.example .env # fill TELEGRAM_BOT_TOKEN + ALLOWED_TELEGRAM_USER_ID
bun run podcast      # download → convert → transcribe → render → Telegram DM
```

What `bun run podcast` does:

1. **Download** — list `meta/` in R2, pull newest metadata + audio (via Wrangler)
2. **Convert** — `public/dialogue.ogg` → `public/dialogue.wav`
3. **Transcribe** — Whisper with language from meta / `clientConfig`
4. **Render** — phone-optimized MP4 named `out/{client}-{title}.mp4`
5. **Telegram** — send the MP4 to your DM with the bot

Meta is cached at `.cache/latest-podcast-meta.json` (gitignored). Client name and podcast title are printed from R2 (no interactive prompts).

**Cloudflare auth:** Wrangler OAuth (`wrangler login`) is enough locally. Optionally set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

**Telegram auth:** same env vars as `jsjoe.io` telegram-webhook — `TELEGRAM_BOT_TOKEN` and `ALLOWED_TELEGRAM_USER_ID` in `.env` (see `.env.example`).

### CI: Run podcast workflow (GitHub Actions)

After a voice note + `N <title>` are saved to R2, you can render **without your laptop**.

CI does **not** compile whisper.cpp (that path is for local `bun run podcast` only). On Actions we use the Marketplace Docker action [appleboy/whisper-action](https://github.com/marketplace/actions/speech-to-text-openai-whisper) (prebuilt whisper.cpp) → SRT → `captions.json` → Remotion → Telegram.

1. Repo **Settings → Secrets and variables → Actions** — add:
   - `TELEGRAM_BOT_TOKEN`
   - `ALLOWED_TELEGRAM_USER_ID`
   - `CLOUDFLARE_API_TOKEN` (R2 read on bucket `telegram-voice`: list + get)
   - `CLOUDFLARE_ACCOUNT_ID`
2. Run the workflow (see below).
3. Finished MP4 arrives in your Telegram DM.

The workflow always pulls the **latest** meta in R2. Workflow file: [`.github/workflows/podcast.yml`](.github/workflows/podcast.yml).

#### How to run without merging to `main`

GitHub only *lists* `workflow_dispatch` workflows that exist on the **default branch**. Once that file is on `main` (it is), you can run **any branch’s code** without merging:

```bash
# Use source + workflow YAML from a feature branch (no merge required)
gh workflow run podcast.yml \
  --ref joe/podcast-ci-whisper-action \
  -R jsjoeio/remotion-audiogram

# Watch
gh run list -R jsjoeio/remotion-audiogram --workflow=podcast.yml
gh run watch -R jsjoeio/remotion-audiogram
```

Also auto-runs on push to branches matching `joe/podcast-ci/**` (handy while iterating on the workflow itself).

UI: **Actions → Podcast pipeline → Run workflow** → pick the branch in the branch dropdown.

#### Local helpers used by CI

| Script | Role |
| --- | --- |
| `bun run podcast:prepare` | R2 download + convert → `public/dialogue.wav` |
| `bun run srt-to-captions` | `public/captions.srt` → `public/captions.json` |
| `bun run podcast:finish` | Render + Telegram (expects captions already present) |
| `bun run podcast` | Full local path (still uses whisper.cpp + medium model) |

Re-send the latest (or a specific) video without re-running the pipeline:

```bash
bun run upload-telegram
bun run upload-telegram out/tim-gailey-hola-joe.mp4
```

### Manual / step-by-step

| Step | Command | Notes |
| --- | --- | --- |
| 1. Download | (pipeline does this) | Or save audio yourself to `public/dialogue.ogg` |
| 2. Convert | `bun run convert-audio` | Backs up original, writes real PCM WAV |
| 3. Transcribe | `bun run transcribe` | First run installs whisper.cpp + ~1.5 GB model |
| 4. Preview | `bun run dev` | Tweak props in Studio sidebar or `src/Root.tsx` |
| 5. Render | `bun run render:phone` | Default path `out/audiogram-phone.mp4` |
| 6. Telegram | `bun run upload-telegram` | DM yourself the MP4 |

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