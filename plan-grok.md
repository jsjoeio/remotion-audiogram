# Plan: Automate podcast pipeline with GitHub Actions

**Status:** research only — do not implement yet  
**Date:** 2026-08-01  
**Repo:** [jsjoeio/remotion-audiogram](https://github.com/jsjoeio/remotion-audiogram)  
**Related:** `jsjoe.io` Worker `workers/telegram-webhook/`

---

## 1. Goal

Today the loop is:

1. Record a voice note → Telegram bot saves audio to R2  
2. Reply `N <title>` → bot writes podcast meta JSON to R2  
3. On your laptop: `bun run podcast`  
4. Video lands in Telegram DM  

Target:

1–2 stay the same, then **CI runs `bun run podcast` without touching the laptop**.  
Trigger: manual (`workflow_dispatch`) first; later automatic from the Telegram bot after meta is saved.

---

## 2. What already exists

### Pipeline (`podcast.ts`)

| Step | What | Local deps |
| --- | --- | --- |
| 0 Download | Latest `meta/` + audio from R2 (`telegram-voice`) | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (or wrangler OAuth) |
| 1 Convert | ogg → `public/dialogue.wav` | ffmpeg (via Remotion) |
| 2 Transcribe | whisper.cpp `medium` → captions | cmake, build-essential; ~1.5 GB model + compiled binaries under `whisper.cpp/` (gitignored) |
| 3 Render | Remotion `Audiogram` phone bitrate | Chrome/Chromium deps |
| 4 Upload | MP4 to Telegram DM | `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_ID` |

### Telegram bot (`jsjoe.io/workers/telegram-webhook`)

- **Voice** → R2 `voice/...`, pending pointer, reply asking for client + title  
- **Text `N title`** → `putPodcastMeta` → R2 `meta/voice/...json`  
- Job is only fully defined **after** meta save — that is the right automation hook, not voice alone  

### Secrets / env

| Variable | Used by | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | bot + upload | Same token for both sides |
| `ALLOWED_TELEGRAM_USER_ID` | bot + upload | Your DM chat id |
| `CLOUDFLARE_API_TOKEN` | `r2-podcast.ts` list/download | Prefer over wrangler OAuth in CI |
| `CLOUDFLARE_ACCOUNT_ID` | `r2-podcast.ts` | Required in CI (no local wrangler config) |

`.env.example` today only documents Telegram vars; CI will need Cloudflare vars documented too.

---

## 3. Open question 1 — Can a GitHub workflow start from an API / Telegram?

**Yes.** Two official patterns:

### A. `workflow_dispatch` (recommended for this repo)

- Workflow declares `on: workflow_dispatch` (optional `inputs`).  
- Any client with a fine-grained PAT (or classic `repo` + Actions) can POST:

```http
POST /repos/jsjoeio/remotion-audiogram/actions/workflows/podcast.yml/dispatches
Authorization: Bearer <GITHUB_TOKEN_WITH_ACTIONS_WRITE>
Accept: application/vnd.github+json

{
  "ref": "main",
  "inputs": {
    "meta_key": "meta/voice/123/.../....json"   // optional later
  }
}
```

- Docs: [Create a workflow dispatch event](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)  
- Also works from UI (Actions → Run workflow) and `gh workflow run podcast.yml`  
- Best when you want **one specific workflow** and typed inputs  

### B. `repository_dispatch` (alternative)

```http
POST /repos/jsjoeio/remotion-audiogram/dispatches

{
  "event_type": "podcast_meta_saved",
  "client_payload": { "meta_key": "...", "client": "..." }
}
```

- Workflow: `on: repository_dispatch: types: [podcast_meta_saved]`  
- Good for many consumers / event bus style; slightly looser than naming a workflow file  

### From the Telegram Worker (side effect)

After successful `putPodcastMeta` in `bot.ts` (~line 231), call GitHub:

```ts
// sketch only — implement later
await fetch(
  `https://api.github.com/repos/jsjoeio/remotion-audiogram/actions/workflows/podcast.yml/dispatches`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jsjoeio-telegram-webhook",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        meta_key: saved.key, // requires pipeline support; see below
      },
    }),
  },
);
```

**Worker secrets to add (later):**

| Secret | Purpose |
| --- | --- |
| `GITHUB_PAT` | Fine-grained PAT: target repo **Actions: Read and write** (Contents: Read if needed) |

**Reply UX (nice-to-have):** after 204/success, bot says “🎬 Rendering started on GitHub Actions” with a link if you also fetch the latest run URL (optional; dispatch alone is fire-and-forget).

**Auth note:** Use a PAT (or GitHub App installation token), **not** a random user’s session. Store only in Worker secrets / GitHub Actions secrets — never in R2 metadata or Telegram messages.

### When to fire the trigger

| Event | Ready to render? | Recommendation |
| --- | --- | --- |
| Voice uploaded | No (missing client/title) | Do **not** start pipeline |
| Meta saved (`N title`) | Yes | **Trigger here** |
| Manual UI / `gh` | Yes (uses latest meta) | Keep for debug / re-runs |

---

## 4. Open question 2 — One step vs split jobs?

### Recommendation: **one job, many steps, aggressive caches**

Keep a single job that ends with `bun run podcast` (same code path as local). Split only the **setup/cache** into steps, not the product logic into multiple jobs.

| Approach | Pros | Cons |
| --- | --- | --- |
| **Single job + `bun run podcast`** | Zero divergence from laptop; easy debug; one place for secrets | First cold run is slow |
| **Multi-job** (download → artifact → whisper job → render job) | Can parallelize later; isolate failures | Artifact I/O for audio/WAV; more YAML; harder re-runs; little win for a serial pipeline |
| **Fully separate reusable actions** | Pretty YAML | Overkill for a personal POC |

### What *is* worth splitting into **steps** (not jobs)

1. Checkout  
2. Install system deps (`build-essential`, `cmake`, Chrome deps if needed)  
3. Setup Bun + `bun install` (cache lockfile)  
4. **Restore `whisper.cpp/`** (binary + `ggml-medium.bin` ~1.5 GB)  
5. `bun run podcast`  
6. Upload log / failure artifacts  

### Caching strategy (this is the real lever)

Local footprint today: `whisper.cpp` ≈ **1.6 GB** (almost all model). GitHub Actions cache is ideal here.

```yaml
# sketch
- uses: actions/cache@v4
  with:
    path: whisper.cpp
    key: whisper-cpp-1.7.4-medium-${{ runner.os }}
```

- **Cold run:** `installWhisperCpp` + `downloadWhisperModel` (cmake build + ~1.5 GB download) — tens of minutes.  
- **Warm run:** restore cache → skip rebuild/download if paths already exist (Remotion helpers are usually no-ops when present).  
- Also cache Bun deps: `~/.bun/install/cache` + `node_modules` keyed on `bun.lock`.  

**Do not** commit `whisper.cpp/` or models to git (already gitignored — keep it that way).

### Optional later: “warm cache” workflow

Scheduled weekly `workflow_dispatch` / `schedule` that only installs whisper + saves cache so the first real podcast of the week is not cold. Nice-to-have, not day one.

### When multi-job would make sense (not now)

- Switch to GPU runners / external Whisper API  
- Remotion Lambda / cloud render separate from transcription  
- Queue many podcasts in parallel  

For personal volume (a few clips/week), single job is enough.

---

## 5. Proposed workflow shape (implement later)

File: `.github/workflows/podcast.yml`

```yaml
name: Podcast pipeline

on:
  workflow_dispatch:
    inputs:
      # Optional later: pin a specific R2 meta key instead of "latest"
      meta_key:
        description: "R2 meta key (empty = latest)"
        required: false
        type: string

# Optional phase 2:
# repository_dispatch:
#   types: [podcast_meta_saved]

jobs:
  podcast:
    runs-on: ubuntu-latest
    timeout-minutes: 180   # long clips + cold whisper
    steps:
      - uses: actions/checkout@v4

      - name: System deps
        run: |
          sudo apt-get update
          sudo apt-get install -y build-essential cmake

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Cache bun deps
        uses: actions/cache@v4
        with:
          path: |
            ~/.bun/install/cache
            node_modules
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}

      - name: Cache whisper.cpp + model
        uses: actions/cache@v4
        with:
          path: whisper.cpp
          key: whisper-1.7.4-medium-${{ runner.os }}

      - run: bun install --frozen-lockfile

      - name: Run pipeline
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          ALLOWED_TELEGRAM_USER_ID: ${{ secrets.ALLOWED_TELEGRAM_USER_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: bun run podcast

      # Optional: upload out/*.mp4 as artifact if Telegram fails
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: debug-workspace
          path: |
            public/captions.json
            out/
          if-no-files-found: ignore
```

Remotion on Linux needs Chromium libraries. First CI run may need:

```bash
# if remotion render complains about missing libs
npx remotion browser ensure
# or install common chrome deps (nss, atk, cups, etc.)
```

Validate on the first dry run; adjust only if render fails.

---

## 6. Code changes required (phases)

### Phase 0 — Manual CI only (smallest useful ship)

1. Add `.github/workflows/podcast.yml` as above.  
2. Repo secrets: `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.  
3. Cloudflare API token scopes: R2 read on `telegram-voice` (list + get).  
4. Smoke: Actions UI → Run workflow → wait for Telegram DM.  
5. Document in README: “CI: Run podcast workflow”.  

**No bot changes.** You still type client/title in Telegram, then click Run workflow (or `gh workflow run`).

### Phase 1 — Bot triggers Actions

1. Create fine-grained PAT (or GitHub App) with Actions write on `remotion-audiogram`.  
2. Worker secret `GITHUB_PAT` (+ maybe `GITHUB_REPO=jsjoeio/remotion-audiogram`).  
3. After `putPodcastMeta` succeeds, POST `workflow_dispatch`.  
4. Bot reply: “Render kicked off” (+ optional link).  
5. Failures: if GitHub returns non-2xx, reply with error so you notice (do not roll back R2 meta).  

### Phase 2 — Target specific job (optional)

Today `fetchLatestPodcastJob` always takes **newest** meta. That races if you save two metas before CI starts.

Improvements:

- Accept `meta_key` env / CLI arg / workflow input.  
- `podcast.ts` + `r2-podcast.ts`: if `META_KEY` set, fetch that object instead of “latest”.  
- Bot passes `saved.key` in dispatch inputs.  

Do this before high volume or concurrent clips.

### Phase 3 — Polish (optional)

- Notify Telegram on CI failure (workflow step calling Bot API, or bot polling — overkill; artifact + email may be enough).  
- Concurrency: `concurrency: { group: podcast, cancel-in-progress: false }` so two jobs queue instead of canceling.  
- Self-hosted runner on your always-on machine if GitHub minutes or CPU time hurt.  
- Smaller Whisper model in CI (`small` / `base`) if quality allows and minutes matter.  

---

## 7. Secrets checklist

### GitHub Actions (repo secrets)

| Secret | Source |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Same as Worker `.dev.vars` |
| `ALLOWED_TELEGRAM_USER_ID` | Same |
| `CLOUDFLARE_API_TOKEN` | New or existing token with R2 read |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard |

### Cloudflare Worker (phase 1)

| Secret | Source |
| --- | --- |
| `GITHUB_PAT` | Fine-grained PAT for `jsjoeio/remotion-audiogram` |

---

## 8. Risks & gotchas

| Risk | Mitigation |
| --- | --- |
| Cold whisper = long first run | Cache `whisper.cpp`; optional warm-cache workflow |
| GHA cache size / eviction | ~1.5 GB model is fine for personal use; pin key by version |
| “Latest meta” race | Phase 2 `meta_key` input |
| Remotion Chrome missing libs | First-run fix; `remotion browser ensure` |
| Runner timeout on long audio | `timeout-minutes: 180`; watch billable minutes |
| Private media in logs | Don’t `cat` audio; keep `public/` out of commits (already) |
| PAT leak | Worker secrets only; rotate if exposed |
| Telegram 50 MB video limit | Already enforced in `upload-telegram.ts`; phone bitrate keeps ~7 MB clips fine |
| Minutes on free/private plan | One job ~10–40 min warm; monitor usage |

---

## 9. Decision summary

| Question | Answer |
| --- | --- |
| API-start a workflow? | **Yes** — `workflow_dispatch` POST (preferred) or `repository_dispatch` |
| From Telegram bot? | **Yes** — after `putPodcastMeta`, Worker calls GitHub with a PAT |
| One step vs split? | **One job**, many setup/cache steps, single `bun run podcast`. Cache whisper + bun. Split jobs only if you outgrow serial CI. |
| First implementation? | Phase 0 only: workflow + secrets + manual dispatch. Bot wiring later. |

---

## 10. Suggested implementation order (next session)

1. [ ] Create Cloudflare R2 read token + account id; store as GH secrets  
2. [ ] Add `.github/workflows/podcast.yml`  
3. [ ] Manual `workflow_dispatch` smoke test end-to-end  
4. [ ] Fix Chrome/cmake issues if any; confirm cache hits on 2nd run  
5. [ ] (Phase 1) PAT + Worker dispatch after meta save  
6. [ ] (Phase 2) `META_KEY` / workflow input so CI is not “latest only”  
7. [ ] README: automated path documented  

No code changes in this session — this document is the plan.
