# Voice call package app starter

This starter is a Kody-authenticated package app shell for a future Cloudflare
Voice integration.

What works now:

- responsive light/dark UI served by a package app
- accessible call controls, transcript log, status announcements, and focus
  states
- pending sound while the model is thinking
- AI SDK tool loop that calls Kody capabilities through `codemode`
- no dependency on Kody `agent_turn_*` primitives

What still needs platform work:

- expose a Workers AI binding to package app workers
- connect the Cloudflare Voice transport (`@cloudflare/voice`) once the package
  app runtime can host the needed voice/Agent bindings

Save the files in this directory with `package_save`, then open the package with
`open_generated_ui({ "kody_id": "voice-call-app" })`.

## Local confidence check

Run this before handing off voice-app changes:

```sh
npm run test:voice-app
```

The command starts the local preview server, opens Chromium with Playwright, and
checks:

- the call button enters listening mode
- the utterance field enables and receives focus
- sending an utterance enters the thinking state
- the pending setup guidance appears when Workers AI is unavailable
- dark mode toggles correctly
- the mobile layout has no horizontal overflow

Screenshots are written to `/tmp/kody-voice-app-self-test` by default. Override
that with `VOICE_APP_ARTIFACT_DIR=/path/to/screenshots`.
