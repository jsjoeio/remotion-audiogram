# Remotion Audiogram Template

This template is for creating "audiograms". In other words, video clips from podcast episodes, or any other audio. It's a popular way of sharing audio snippets on social media.

[Example video](https://twitter.com/marcusstenbeck/status/1460641903326732300)

<p align="center">
  <img src="https://github.com/marcusstenbeck/remotion-template-audiogram/raw/main/Promo.png">
</p>

## Getting started

```bash
bun install
bun run dev
```

`bun run dev` is the same as `npx remotion studio` — it just runs the `dev` script from `package.json`, which starts Remotion Studio. Use whichever you prefer.

Start changing things like this:

- Adjust parameters in `src/Root.tsx` or in the Studio sidebar
- Replacing audio, cover and subtitles in the `public` folder

## Workflow: Telegram audio → audiogram

Audio saved from Telegram is usually **Opus inside an Ogg container**, even if your browser names it `.wav`.  
Remotion Studio needs a real PCM WAV file. The template is wired to `public/dialogue.wav` (see `src/Root.tsx`).

**Privacy:** nothing in `public/` is committed to git (audio, captions, cover image). Those files stay on your machine only. After cloning, you add your own assets locally.

### Step 1 — Download from Telegram

1. Open the voice message in Telegram (desktop or web).
2. Download/save the audio into the `public/` folder.

**Easiest naming (recommended):** save it as `public/dialogue.wav`.  
The extension is wrong, but that matches what this project expects — you'll fix it in step 2.

**Also fine:** save as `public/dialogue.ogg` (or whatever Telegram calls it). You'll just type that path when `convert-audio` asks.

### Step 2 — Convert to a real WAV

```bash
bun run convert-audio
```

The script asks three questions. Press **Enter** to accept each default unless noted below.

| Prompt | Default | What to do |
| --- | --- | --- |
| Path to audio file | `./public/dialogue.wav` | Press Enter if you saved as `dialogue.wav`. If you saved as `dialogue.ogg`, type `./public/dialogue.ogg`. |
| Output WAV path | same as input | **If input is `dialogue.ogg`:** type `./public/dialogue.wav` so the template can find it. **If input is already `dialogue.wav`:** press Enter (overwrites in place). |
| Sample rate | `48000` | Press Enter |

What the script does:

- Detects the real format (Ogg/Opus, MP3, etc.) — the file extension does not matter
- Backs up the original before overwriting (e.g. `public/dialogue-original.wav` or `public/dialogue-original.ogg`)
- Writes a Remotion-ready `public/dialogue.wav`

Check the result:

```bash
file public/dialogue.wav
# Bad:  Ogg data, Opus audio
# Good: RIFF (little-endian) data, WAVE audio
```

### Step 3 — Transcribe captions

```bash
bun run transcribe
```

Prompts:

- **Audio path:** press Enter (default `./public/dialogue.wav`)
- **Speech start:** it now auto-detects the moment real speech begins (using `silencedetect`). It prints the detected value (e.g. 0.116) and uses it as default. Override only if needed.
- **Language:** press Enter for `auto` detect, or type `Spanish` / `es`
- **Additional caption sync offset:** new! Enter a number like `-0.12` (negative) if after previewing you feel the text appears behind the words. This is a fast way to nudge timing. Leave at 0 for first run.

First run installs whisper.cpp and downloads the medium model (~1.5 GB).  
Output: `public/captions.json`

### Step 4 — Preview in Remotion Studio

```bash
bun run dev
# same as: npx remotion studio
```

### Transcription prerequisites (Linux / WSL)

Whisper.cpp is compiled from source on first run. Install build tools first:

```bash
sudo apt update
sudo apt install -y build-essential cmake
```

## How do I render my video?

Run this:

```console
npx remotion render
```

Or check out the [Remotion docs](/docs/render/). There are lots of ways to render.

## Where to get a transcript?

You can generate the captions or supply a .srt file or a .json file that follows the [`@remotion/captions`](https://remotion.dev/docs/captions/caption) format.

### Generate captions

- With the built-in transcription script using [`@remotion/install-whisper-cpp`](https://www.remotion.dev/docs/install-whisper-cpp/):

  ```bash
  bun run transcribe
  # With Node.js: `npx tsx transcribe.ts`
  ```

  This will:

  - Ask for your audio file path
  - Auto-detect when actual speech begins in the audio (via ffmpeg silencedetect) so you rarely need to guess the "start second"
  - Ask for language
  - Ask for an optional extra sync offset in seconds (e.g. -0.1) — use this to quickly correct "text feels behind" without re-running the expensive transcription
  - Generate `public/captions.json`

**Fast timing tweaks (no re-transcribe):**

If the captions are slightly out of sync with the voice after previewing in Studio:

```bash
# Advance all text by 120ms (makes words appear earlier)
bun run shift-captions -0.12

# Or interactive
bun run shift-captions
```

This instantly edits `public/captions.json`. Remotion Studio will hot-reload the updated timings. Much faster than changing the start-second and re-transcribing.

- Alternatively, use [`@remotion/openai-whisper`](https://www.remotion.dev/docs/openai-whisper/openai-whisper-api-to-captions) to get captions from OpenAI Whisper into the right shape.

**Get it from a provider:**

- Your podcasting host might provide them for you.
- Descript makes transcription really easy.
- There are tons of other, paid solutions, like [Otter.ai](https://otter.ai), [Scriptme.io](https://scriptme.io) and [ListenRobo.com](https://listenrobo.com).

If you supply a .srt, make sure to export subtitles that are segmented by word rather than by sentence.

## Optimizing for long audio files

If your audio is long, make sure to pass a `.wav` file as audio.  
The template will use [`useWindowedAudioData()`](/docs/use-windowed-audio-data) to only fetch the data around the current time.

Otherwise, the waveform of the whole audio needs to be fetched, which may be slow.

## Docs

Get started with Remotion by reading the [fundamentals page](https://www.remotion.dev/docs/the-fundamentals).

## Help

We provide help [on our Discord server](https://discord.gg/6VzzNDwUwV).

## Issues

Found an issue with Remotion? Upgrade Remotion to receive fixes:

```
npx remotion upgrade
```

Didn't help? [File an issue here](https://github.com/remotion-dev/remotion/issues/new).

## Contributing

The source of this template is in the [Remotion Monorepo](https://github.com/remotion-dev/remotion/tree/main/packages/template-audiogram).  
Don't send pull requests here, this is only a mirror.

## License

Note that for some entities a company license is needed. Read [the terms here](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
