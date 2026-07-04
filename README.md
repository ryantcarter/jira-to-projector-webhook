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
- **Time** — the team's tracked time crosses over too (`--time-only` to run
  just this pass). ClickUp's `time_entries` endpoint only returns the caller's
  own entries unless every member is named in `assignee`, so we pass the full
  member list; entries are attributed to the real person, dated, and idempotent
  on `clickup:time:<id>`. (~528 entries / 870h on Evoke at first import.)

```bash
cp .env.example .env   # fill in tokens
node scripts/backfill.js --dry-run          # preview, no writes
node scripts/backfill.js --dry-run --limit 5
node scripts/backfill.js --task CRTR-286     # one task, real write
node scripts/backfill.js                     # the lot (274 tasks)
```

Everything is idempotent — safe to re-run after a failure or to catch up.

## 2. Live service (`server.js`) — built

The webhook listener that keeps Projector current from Jira, running next to
the ClickUp bridge on its own port. Because Projector upserts are idempotent
(`external_source`+`external_id`) and comments dedupe on `jira:comment:<id>`,
there is **no local snapshot/diff engine** — each webhook simply re-asserts the
desired state.

Endpoints (basic-auth guarded): `POST /jira/issue-created`,
`/jira/issue-updated`, `/jira/comment-added`, plus `GET /health`. Each one:

1. Upserts the task (`ref_number` = the Jira issue number, so CRTR-220 → EVK-220).
2. Re-asserts title / description / status / due date / assignee on updates.
3. Syncs the issue's comments (author-attributed, backdated, internal notes).

An in-memory **high-water mark** per issue drops out-of-order webhooks so an
older payload can't revert newer state. `config/jira-status-map.json` maps Jira
statuses → Projector's 8; `config/jira-identity-map.json` resolves Jira actors
→ Projector emails (unresolved comment authors fall back to the key's person,
so nothing is lost; unresolved assignees are omitted).

```bash
node scripts/smoke.js          # dry-run the mapping over samples/ (no writes)
pnpm start                     # run the listener
pm2 start ecosystem.config.cjs # production, alongside xml-to-clickup
```

**Deploy** (same as xml-to-clickup): a Forge site whose deploy script is
`forge-deploy.sh`; the app runs under pm2 on port 38473 and Forge's nginx
reverse-proxies the site's domain → `127.0.0.1:38473`. The `.env` lives in the
site path on the server (not in git).

**Wiring it up:** point the same Jira webhook/automation that feeds
xml-to-clickup at this service's domain too — the create / update / comment
endpoints, with the same basic-auth creds:
`https://<user>:<pass>@<domain>/jira/issue-updated`. Both systems then move
together off the one Jira feed.

## Layout

```
config/identity-map.json       ClickUp email → Projector email (backfill)
config/status-map.json         ClickUp status → Projector status (backfill)
config/jira-status-map.json    Jira status → Projector status (live)
config/jira-identity-map.json  Jira actor → Projector email (live)
lib/clickup.js                 ClickUp v2 read client (throttled)
lib/projector.js               Projector REST write client
lib/jira.js + jira-markdown.js Jira payload → Projector shapes
scripts/backfill.js            the one-time mirror (+ --time-only)
scripts/smoke.js               dry mapping test over samples/
server.js                      the live webhook listener
```
