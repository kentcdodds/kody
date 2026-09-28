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
npm run typecheck
```

`studio` and `render` regenerate the score first (`npm run music`), so the WAV
under `public/music/` is never committed. Output lands in `out/`, which is
gitignored. Encoding settings (CRF 16, x264 `slow`, bt709, AAC 256k) live in
`remotion.config.ts`.

## Composition

- Entry: `src/index.ts`, composition id `PersonalSoftwareConnected`
  (`src/personal-software-connected.tsx`).
- Edit map: `src/timing.ts` (120 BPM, one bar = 60 frames) and
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
- The one outside asset is `src/art/noto-emoji-weary-face.svg`, the 😩 image
  from [Noto Emoji](https://github.com/googlefonts/noto-emoji) (Apache 2.0). It
  is a file rather than text so the render never depends on a system emoji font.

## Music

`scripts/generate-music.ts` synthesizes an original track in code (FM keys,
supersaw pads, bass, drums, reverb) with a fixed seed, so the output is
deterministic and carries this repo's license. The drop on bar 6 lands on frame
300 as the lantern lights. If you change the tempo or bar map, change
`src/timing.ts` to match.
