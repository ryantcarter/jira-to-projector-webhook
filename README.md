# jira-to-projector

Bridges the **Evoke** work into [Projector](https://projector-nine.vercel.app),
running alongside the existing `xml-to-clickup` service so both PM systems stay
in step during the parallel-run period.

Two parts:

## 1. Backfill (`scripts/backfill.js`) — done / re-runnable

A one-time mirror of the ClickUp Evoke board into Projector. Pulls every task
and its comments and writes them over the Projector REST API.

- **Tasks** — keyed by their **Jira issue** (`external_source=jira`,
  `external_id=<Jira ID>`) so the mirror and the live Jira feed address the
  *same* Projector task. Re-running never duplicates.
- **Status** — ClickUp's 15 statuses collapse onto Projector's 8 via
  `config/status-map.json`.
- **Custom fields** — the Jira ID and Jira URL land on two internal fields
  (staff-only) on the Evoke board.
- **Comments** — attributed to the real author (`config/identity-map.json`,
  ClickUp email → Projector email), backdated, idempotent on an `external_id`.
  Jira-synced ClickUp comments reuse the Jira comment id as their key so the
  live service won't re-add them. Imported as **internal notes** by default
  (`COMMENTS_INTERNAL=true`).
- **Time** — deliberately none. The Evoke team never used ClickUp's timer
  (0 entries), so there is no genuine duration data to mirror. Projector's
  time-import endpoint exists for when real tracking begins.

```bash
cp .env.example .env   # fill in tokens
node scripts/backfill.js --dry-run          # preview, no writes
node scripts/backfill.js --dry-run --limit 5
node scripts/backfill.js --task CRTR-286     # one task, real write
node scripts/backfill.js                     # the lot (274 tasks)
```

Everything is idempotent — safe to re-run after a failure or to catch up.

## 2. Live service (Phase C) — planned

A fork of `xml-to-clickup`'s Jira snapshot/diff engine with the ClickUp writer
swapped for `lib/projector.js`. The same Jira webhook fans out to both systems,
so Projector tracks status/field/comment changes the same way ClickUp does.
Deploys next to the ClickUp bridge on its own port.

## Layout

```
config/identity-map.json   ClickUp email → Projector email (authors, assignees)
config/status-map.json     ClickUp status → Projector status
lib/clickup.js             ClickUp v2 read client (throttled)
lib/projector.js           Projector REST write client
scripts/backfill.js        the mirror
```
