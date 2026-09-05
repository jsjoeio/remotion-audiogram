# Audiogram POC

Turn podcast clips (or any audio) into shareable square videos with captions and a spectrum visualizer — **or** publish enhanced AAC to a public R2 bucket for `app.jsjoe.io` program links.

```bash
bun install
bun run dev          # Remotion Studio
```

**Privacy:** `public/` and `.cache/` are gitignored — audio, captions, cover, and R2 job meta stay local.

---

## App audio path (Phase 1 / PREV-751)

Default CI path: download from private `telegram-voice` → loudness enhance → **AAC (.m4a @ 96k)** → upload to public bucket **`wellness-program-audio`**.

```bash
# Local (needs wrangler login or CLOUDFLARE_* + PUBLIC_AUDIO_BASE_URL)
bun run podcast:app
```

Object key shape:

```text
program/{clientKey}/{YYYY-MM-DD}-{slug}.m4a
```

Client URL (once the bucket is publicly reachable):

```text
${PUBLIC_AUDIO_BASE_URL}/program/{clientKey}/{YYYY-MM-DD}-{slug}.m4a
```

### One-time Cloudflare setup (public access)

1. Bucket **`wellness-program-audio`** already exists in the account.
2. In Cloudflare Dashboard → R2 → `wellness-program-audio` → **Settings**:
   - For quick testing: enable **Public Development URL** (`*.r2.dev`) and set that as `PUBLIC_AUDIO_BASE_URL` / Actions secret.
   - For production: connect a **custom domain** (e.g. `audio.jsjoe.io`) and use that as `PUBLIC_AUDIO_BASE_URL`.
3. Ensure the Actions `CLOUDFLARE_API_TOKEN` can **read** `telegram-voice` and **write** `wellness-program-audio`.

Whisper / Remotion video / Telegram upload remain in the repo (`bun run podcast`, `podcast:prepare`, `podcast:finish`) and are **commented out** in `.github/workflows/podcast.yml` — uncomment those steps to restore the audiogram path.

---

## Workflow: Telegram → R2 → video

Voice notes go to the Telegram bot ([jsjoe.io](https://github.com/jsjoeio/jsjoe.io) `telegram-webhook`), which stores audio + metadata in R2 (`telegram-voice`). This repo pulls the latest job and either publishes AAC for the app or renders an audiogram.

### One-shot pipeline (full video)

```bash
npx wrangler login   # once per machine (R2 downloads)
cp .env.example .env # fill TELEGRAM_BOT_TOKEN + ALLOWED_TELEGRAM_USER_ID
bun run podcast      # download → convert → transcribe → render → Telegram topic (or DM)
```

What `bun run podcast` does:

1. **Download** — list `meta/` in R2, pull newest metadata + audio (via Wrangler)
2. **Convert** — source → `public/dialogue.raw.wav` (PCM, unprocessed)
3. **Enhance** — FFmpeg loudness chain → `public/dialogue.wav` (~−16 LUFS)
4. **Transcribe** — Whisper with language from D1 clients (fallback: R2 meta)
5. **Render** — phone-optimized MP4 named `out/{client}-{title}.mp4`
6. **Telegram** — send the MP4 to the client's forum topic (falls back to your DM if unmapped)

Meta is cached at `.cache/latest-podcast-meta.json` (gitignored). Client name and podcast title are printed from R2 (no interactive prompts).

**Cloudflare auth:** Wrangler OAuth (`wrangler login`) is enough locally. Optionally set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

**Clients:** roster lives in D1 (`jsjoeio.clients`, same as the Telegram bot). Check without running the full pipeline:

```bash
bun run clients   # wrangler d1 execute --remote
```

**Telegram auth:** same env vars as `jsjoe.io` telegram-webhook — `TELEGRAM_BOT_TOKEN` and `ALLOWED_TELEGRAM_USER_ID` in `.env` (see `.env.example`). To post in a client topic, also set `TELEGRAM_GROUP_CHAT_ID` (the group's `-100…` id). Topic id comes from R2 meta (`telegramTopicId`), snapshotted by the bot from D1.

### CI: Run podcast workflow (GitHub Actions)

After a voice note + `N <title>` are saved to R2, run the workflow. **Default job publishes public AAC** (see App audio path above).

To restore Whisper → Remotion → Telegram in CI, uncomment the block in [`.github/workflows/podcast.yml`](.github/workflows/podcast.yml).

```bash
gh workflow run podcast.yml --ref <branch> -R jsjoeio/remotion-audiogram
```

Repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and ideally `PUBLIC_AUDIO_BASE_URL`. Telegram secrets only needed for the video path.

---

## Audio enhance (podcast loudness)

AirPods voice notes are thin and quiet. Remotion only plays audio, so `podcast:prepare` / `podcast:app` run an FFmpeg chain on the **full** WAV **before** encode or Whisper. Target: **~−16 LUFS**, true peak **≤ −1.5 dBTP**.

**Denoise** is optional and **off by default**. Enable only if a clip is noisy:

```bash
PODCAST_DENOISE=off      # default
PODCAST_DENOISE=afftdn   # light FFT denoise
PODCAST_DENOISE=arnndn   # RNNoise
```

```bash
bun run enhance-audio   # public/dialogue.raw.wav → public/dialogue.wav
```

---

## Docs & help

- [Remotion fundamentals](https://www.remotion.dev/docs/the-fundamentals)
- [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Discord](https://discord.gg/6VzzNDwUwV)
