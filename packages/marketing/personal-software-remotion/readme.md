# Personal software, connected to everything

A 29.5-second Remotion motion piece for Kody (1920×1080, 30fps, H.264 with
music). It is a standalone marketing project: not an npm workspace, not imported
by any worker, and not part of `npm run validate`.

## Commands

Run from this folder (Node 26):

```bash
npm install
npx remotion browser ensure   # first run only: Remotion's headless Chrome
npm run studio                # preview and scrub in Remotion Studio
npm run render                # out/personal-software-connected.mp4
npm run soundtrack            # rebuild public/music/ (see Sound)
npm run typecheck
```

Output lands in `out/`, which is gitignored. Encoding settings (CRF 16, x264
`slow`, bt709, AAC 256k) live in `remotion.config.ts`.

## Composition

- Entry: `src/index.ts`, composition id `PersonalSoftwareConnected`
  (`src/personal-software-connected.tsx`).
- Edit map: `src/timing.ts` (120 BPM, one bar = 60 frames),
  `src/opening-cues.ts` (Beat 1's cue sheet and app windows), and
  `src/choreography.ts` (shared cue sheet for lantern pulses, arrivals, the
  zoom-out, and triggers).
- Many-apps pull-back: `src/app-grid.ts` lays 52 apps out in world space around
  the lantern's hub cell and drives the camera. Each app spawns on the frame it
  first enters the shot, so apps arrive faster as the zoom accelerates.

| Time     | Beat                     | On-screen copy                                         |
| -------- | ------------------------ | ------------------------------------------------------ |
| 0–10s    | Integration tax          | You need a new app. → …again, and again… → Ugh 😩      |
| 10–16s   | Connect once             | Connect once. Keep them in Kody.                       |
| 16–23s   | Generate, then many apps | Generate software that already has the connections.    |
| 23–26s   | Stays lit                | Agents come and go. Your software stays lit.           |
| 26–29.5s | Close                    | Personal software, connected to everything. kody.codes |

## Assets

Everything visual is imported from the app so the video tracks what kody.codes
ships:

- Lantern still and the six primitive orbs:
  `packages/worker/public/images/lantern/`.
- Orb placements, frame-opening clip path, and glass geometry:
  `packages/worker/universal/landing-lantern.ts`. Primitive words come from
  `packages/worker/universal/landing-home-copy.ts`.
- Colors: the dark-mode tokens from `packages/worker/public/styles.css`
  (`src/theme.ts`).
- Fonts: Bricolage Grotesque and Wix Madefor Text from
  `packages/worker/public/fonts/`.
- Logo and pattern: `packages/worker/public/logo-240.webp` and
  `packages/worker/public/images/kody-pattern.webp`.
- Service and agent marks: `packages/worker/public/images/icons/*.svg`, plus the
  Google mark paths from `packages/worker/client/provider-icons.tsx`.
- The one outside visual is `src/art/noto-emoji-weary-face.svg`, the 😩 image
  from [Noto Emoji](https://github.com/googlefonts/noto-emoji) (Apache 2.0). It
  is a file rather than text so the render never depends on a system emoji font.

## Sound

Two layers, both keyed to the same cue frames as the visuals:

- `public/music/personal-software-soundtrack.m4a` (committed) is built by
  `npm run soundtrack` (`scripts/build-soundtrack.ts`). It needs ffmpeg with
  librubberband on `PATH` (Homebrew's ffmpeg has it) and downloads the Suno
  source, "Personal software" by Kent, once into `.cache/`. It cuts the track's
  drop, pre-chorus into chorus, and final hit, stretches each from about 122 BPM
  onto the 120 BPM grid so the drop lands on frame 300 as the lantern lights and
  the final hit on frame 780 under the tagline, then adds the opening's sound
  design (clock tick-tock that speeds up with the repeats, a low drone, a tape
  stop and deflate on "Ugh", and a reverse swell into the drop). The mix is
  normalized to -14 LUFS.
- `src/components/sound-effects.tsx` places UI one-shots from `public/sfx/`
  (Kenney's Interface, UI Audio, and Impact packs, CC0; see
  `public/sfx/license.txt`) on the cue frames: card pops, window whooshes,
  checklist ticks, "Live", the "and again…" thuds, the "Ugh" slam, and pings as
  services land in the lantern and triggers fire.

If you change the bar map in `src/timing.ts` or the opening cues, rebuild the
soundtrack.
