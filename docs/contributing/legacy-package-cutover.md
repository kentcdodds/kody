# Legacy Package Cutover

This note records the current production-critical legacy-to-package migration
state for Kent's workspace after the package-first production rollout.

## Migrated packages

### `shade-automation`

- Package id: `1a0476b4-c1d6-47ad-802e-dd5f4631c919`
- Exports: `kody:@shade-automation/plan-day`,
  `kody:@shade-automation/estimate-day`, `kody:@shade-automation/run-event`,
  `kody:@shade-automation/event-runner`, `kody:@shade-automation/tick`,
  `kody:@shade-automation/cloud-watch`
- Package jobs:
  - `daily-plan` (`cron` `5 3 * * *`, `America/Denver`, disabled)
  - `event-runner` (`interval` every `1m`, `America/Denver`, disabled)
  - `cloud-watch` (`interval` every `10m`, `America/Denver`, disabled)
- Smoke checks completed:
  - `plan-day` dry run passed with live config and persisted actionable events
  - `estimate-day` passed for clear and overcast scenarios, including the
    kitchen south/west glare windows and studio-lighting office suppression
  - `run-event` dry run passed, including skipping office sheers while studio
    lighting is on
  - `event-runner` dry run passed and picked up the due `hot-east-close` event
    from the persisted plan
  - `tick` dry run passed with combined scheduled-event and cloud-watch behavior
  - `cloud-watch` dry run passed against the live config shape, including
    kitchen south/west glare handling and ignore-manual-change enforcement
- Package-native adaptation:
  - The package now replaces legacy one-off event jobs with a persisted daily
    plan plus the disabled `event-runner` package job.
  - The legacy `shade-automation-estimate-day` reporting use case is now
    package-native as `kody:@shade-automation/estimate-day`.
  - Scheduled-event execution writes to
    `job:package-job:1a0476b4-c1d6-47ad-802e-dd5f4631c919:event-runner`.
  - Office sheers are now suppressed end to end while studio lighting is on, and
    `cloud-watch` reconciles them once recording is over.
  - Afternoon glare windows now explicitly cover kitchen south, kitchen west,
    great room west, and the kitchen door using the package-native overcast
    hysteresis rules.

### `github-activity-discord`

- Package id: `7016b0aa-02f4-4a46-9466-0c0ccf3a1745`
- Exports: `kody:@github-activity-discord/daily-summary`,
  `kody:@github-activity-discord/activity-summary`,
  `kody:@github-activity-discord/weekly-summary`
- Package jobs:
  - `daily-discord` (`cron` `0 3 * * *`, `America/Denver`, disabled)
  - `weekly-discord` (`cron` `0 17 * * 5`, `America/Denver`, disabled)
- Smoke checks completed:
  - `daily-summary` passed with `postToDiscord: false` and returns a reusable
    Discord message payload
  - `activity-summary` passed for a bounded 24-hour range
  - `weekly-summary` passed for a bounded 7-day range after handling GitHub's
    user-events pagination cap on page 4+ and now also returns a reusable
    Discord message payload
- Package-native adaptation:
  - GitHub summary generation is now separated from Discord delivery formatting
    and posting concerns via shared package helpers.
  - `daily-discord` and `weekly-discord` are now thin job wrappers around the
    `daily-summary` and `weekly-summary` exports instead of owning their own
    Discord formatting logic.
  - Daily and weekly jobs now share the same user-configured username, timezone,
    and channel settings path.

### `personal-history`

- Package id: `349f7e6c-f4c1-40e3-8436-644275919cc4`
- Exports: `kody:@personal-history/state-ensure`,
  `kody:@personal-history/prompt-to-discord`,
  `kody:@personal-history/daily-prompt`
- Package jobs:
  - `state-store` (`once` at `2099-01-01T00:00:00Z`, disabled)
  - `daily-prompt-scheduler` (`cron` `*/5 * * * *`, `America/Denver`, disabled)
- Smoke checks completed:
  - `state-ensure` passed and resolved the package-owned storage id
  - `prompt-to-discord` passed with `postToDiscord: false`
  - `daily-prompt` passed with `postToDiscord: false`
- Package-native adaptation:
  - `prompt-to-discord` no longer depends on the legacy `journal-interview`
    skill at runtime. It loads journal context directly from the journal D1/R2
    data.
  - `daily-prompt` no longer depends on the legacy
    `personal-history-daily-prompt` or `journal-interview` paths at runtime. It
    reads journal D1 data directly and can drive the disabled package-owned
    scheduler job.

## Cutover gates

### `shade-automation`

1. Enable `daily-plan` and `event-runner` together; do not enable one without
   the other.
2. Before disabling the legacy shade planner/event-job path, run one full
   package rehearsal while confirming:
   - `shadeAutomationPlan` is refreshed for the current local date with
     actionable events
   - scheduled-event execution writes to
     `job:package-job:1a0476b4-c1d6-47ad-802e-dd5f4631c919:event-runner`
   - cloud-watch writes to
     `job:package-job:1a0476b4-c1d6-47ad-802e-dd5f4631c919:cloud-watch`
   - one due event and one cloud-watch tick actuate as expected without
     duplicate sends
3. Only disable the legacy planner/event-job path after the package jobs cover a
   full day successfully.

### `github-activity-discord`

1. Compare one package-generated daily summary and one weekly summary against
   the legacy outputs with Discord posting disabled.
2. Enable `daily-discord` first, confirm the message posts to channel
   `1491568683737157683`, then leave the legacy job disabled.
3. Repeat for `weekly-discord`.
4. Only remove the legacy GitHub summary rows after both package jobs post the
   expected content for at least one full cycle each.

### `personal-history`

1. Before using the package-owned scheduler, confirm `state-ensure` keeps
   writing the compatibility values:
   - `personalHistoryDiscordStateJobId`
   - `personalHistoryDiscordStateStorageId`
2. Run one real package prompt with Discord posting enabled and verify:
   - the root message posts to the configured channel
   - the thread is created successfully
   - the returned subject/question are grounded in current journal data
3. Enable `daily-prompt-scheduler`, confirm it chooses a target minute inside
   the configured local window, and verify it posts only once for that date.
4. Keep the legacy Discord thread-handler path in place until a package-native
   replacement exists.

## Out of scope

- Everything in `legacy_inline_sources_archive`
- Any archived legacy jobs, skills, or apps that were already removed from the
  live tables
- Tesla and Spotify app migration beyond the explicit package work above

### Live repo-backed apps left out of this pass

- `Facet counter (smoke test)`
- `Hello World Time Demo`
- `Image Viewer`
- `KentCDodds Screenshot Viewer`
- `Shape & Color Match`
- `Spotify Playback Remote`
- `TRON Mortgage Calculator`

### Live repo-backed skills left out of this pass

- Shade helpers and earlier prototypes:
  - `bond-area-shades`
  - `bond-room-shades`
  - `shade-solar-action`
  - `shade-solar-cron`
  - `shade-solar-planner`
  - `weather-forecast`
- Cursor cloud agent helpers:
  - `cursor-agent-status-overview`
  - `delete-cursor-cloud-agent`
  - `follow-up-on-cursor-cloud-agent`
  - `get-cursor-cloud-agent-details`
  - `get-cursor-cloud-api-key-info`
  - `launch-cursor-cloud-agent`
  - `list-cursor-accessible-repositories`
  - `list-cursor-cloud-agent-models`
  - `list-cursor-cloud-agents`
  - `read-cursor-cloud-agent-docs`
  - `stop-cursor-cloud-agent`
- Journal and Discord supporting skills:
  - `discord-event-handler`
  - `general-thread-discord-handler`
  - `general-thread-generate-reply`
  - `general-thread-summarize-thread`
  - `journal-delete`
  - `journal-edit`
  - `journal-interview`
  - `journal-list`
  - `journal-read`
  - `journal-search`
  - `journal-upsert-for-thread`
  - `journal-write`
- Spotify skills:
  - `spotify-add-to-queue`
  - `spotify-get-queue`
  - `spotify-play-pause`
  - `spotify-playback-controller`
  - `spotify-playback-state`
  - `spotify-set-volume`
  - `spotify-skip-next`
  - `spotify-skip-previous`
  - `spotify-transfer-playback`
- Other utilities and integrations:
  - `browser-screenshot`
  - `cloudflare-api-v4`
  - `personal-automation-repo-guide`
  - `repo-migration-runtime-smoke`
  - `roku-play-youtube`
  - `tesla-fleet-api-documentation-lookup`
  - `transistor-fm-api`

### Live repo-backed jobs left out of this pass

- None outside the three critical domains
