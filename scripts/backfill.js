// One-time (and safely re-runnable) mirror of the ClickUp Evoke board into
// Projector. Tasks, statuses, custom fields, assignees and comments cross
// over; everything is idempotent (tasks keyed by Jira issue, comments by an
// external_id) so this can be run repeatedly and after failures.
//
// Usage:
//   node scripts/backfill.js [--dry-run] [--limit N] [--task CRTR-286]
//
// There is deliberately no time-tracking pass: the Evoke team never used
// ClickUp's timer (0 entries), so there is no genuine duration data to
// mirror. The Projector time endpoint exists for when real tracking begins.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeClickup, customField } from "../lib/clickup.js";
import { makeProjector } from "../lib/projector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// --- tiny .env loader (no dependency) ---
function loadEnv() {
  const out = { ...process.env };
  try {
    for (const line of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch {
    /* no .env — rely on process.env */
  }
  return out;
}

const env = loadEnv();
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 ? Number(args[i + 1]) : Infinity;
})();
const ONLY_TASK = (() => {
  const i = args.indexOf("--task");
  return i >= 0 ? args[i + 1] : null;
})();

const required = ["CLICKUP_TOKEN", "CLICKUP_LIST_ID", "PROJECTOR_API_URL", "PROJECTOR_API_KEY"];
for (const k of required) {
  if (!env[k]) {
    console.error(`Missing ${k} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const identity = JSON.parse(
  readFileSync(path.join(root, "config", "identity-map.json"), "utf8"),
).map;
const statusCfg = JSON.parse(
  readFileSync(path.join(root, "config", "status-map.json"), "utf8"),
);

const clickup = makeClickup(env.CLICKUP_TOKEN);
const projector = makeProjector({
  apiUrl: env.PROJECTOR_API_URL,
  apiKey: env.PROJECTOR_API_KEY,
  clientSlug: env.PROJECTOR_CLIENT_SLUG || "evoke",
  writeDelayMs: Number(env.WRITE_DELAY_MS || 120),
});

const EXTERNAL_SOURCE = env.EXTERNAL_SOURCE || "jira";
const COMMENTS_INTERNAL = String(env.COMMENTS_INTERNAL ?? "true") === "true";

const stats = {
  tasks: 0,
  tasksCreated: 0,
  tasksExisting: 0,
  comments: 0,
  commentsSkipped: 0,
  assigneesDropped: 0,
  errors: [],
};

// "CRTR-220" → 220 (the numeric suffix), or null if there isn't one.
function jiraNumber(jiraId) {
  const m = /(\d+)\s*$/.exec(String(jiraId));
  return m ? Number(m[1]) : null;
}

function mapStatus(clickupStatus) {
  const key = (clickupStatus || "").toLowerCase();
  return statusCfg.map[key] || statusCfg.default;
}

// ClickUp assignee emails -> Projector staff emails (only mapped, known ones).
function mapAssignees(task) {
  const emails = [];
  for (const a of task.assignees || []) {
    const email = (a.email || "").toLowerCase();
    const mapped = identity[email];
    if (mapped) emails.push(mapped);
    else stats.assigneesDropped++;
  }
  return [...new Set(emails)];
}

// A Jira-synced ClickUp comment carries a "— Jira comment #NNNN" marker; use
// that so the mirror and the live Jira→Projector service agree on the key.
function commentExternalId(comment) {
  const m = /Jira comment #(\d+)/.exec(comment.comment_text || "");
  return m ? `jira:comment:${m[1]}` : `clickup:comment:${comment.id}`;
}

async function importTask(task) {
  const jiraId = customField(task, "Jira ID");
  if (!jiraId) {
    stats.errors.push(`${task.id} (${task.name}): no Jira ID — skipped`);
    return;
  }
  if (ONLY_TASK && jiraId !== ONLY_TASK) return;

  stats.tasks++;
  const jiraUrl = customField(task, "Jira");
  const status = mapStatus(task.status?.status);
  const assignees = mapAssignees(task);
  const body = {
    title: task.name,
    description: task.description || task.text_content || "",
    status,
    assignees,
    external_source: EXTERNAL_SOURCE,
    external_id: jiraId,
    // Mirror the Jira issue number into the Projector ref: CRTR-220 → EVK-220.
    ...(jiraNumber(jiraId) ? { ref_number: jiraNumber(jiraId) } : {}),
    fields: {
      "Jira ID": jiraId,
      ...(jiraUrl ? { "Jira URL": jiraUrl } : {}),
    },
  };
  if (task.due_date) body.due_date = new Date(Number(task.due_date)).toISOString();

  if (DRY) {
    console.log(
      `DRY task ${jiraId} "${task.name.slice(0, 50)}" → ${status}` +
        (assignees.length ? ` [${assignees.join(",")}]` : ""),
    );
  }

  let ref;
  if (!DRY) {
    const res = await projector.upsertTask(body);
    ref = res.ref;
    if (res.existing) stats.tasksExisting++;
    else stats.tasksCreated++;
    // A replayed (existing) task still needs its status/fields brought
    // up to date — the idempotent create only fires on first insert.
    if (res.existing) {
      await projector.patchTask(ref, { status, title: task.name });
    }
  }

  // Comments.
  const comments = await clickup.taskComments(task.id);
  for (const c of comments) {
    const text = (c.comment_text || "").trim();
    if (!text) continue;
    const email = (c.user?.email || "").toLowerCase();
    const author = identity[email];
    if (!author) {
      stats.commentsSkipped++;
      if (DRY) console.log(`   DRY skip comment by unmapped ${email || "?"}`);
      continue;
    }
    const payload = {
      body: text,
      author,
      created_at: new Date(Number(c.date)).toISOString(),
      external_id: commentExternalId(c),
      internal: COMMENTS_INTERNAL,
    };
    if (DRY) {
      console.log(`   DRY comment ${payload.external_id} by ${author}`);
    } else {
      await projector.importComment(ref, payload);
    }
    stats.comments++;
  }
}

async function main() {
  console.log(
    `${DRY ? "[DRY RUN] " : ""}Mirroring ClickUp list ${env.CLICKUP_LIST_ID} → ` +
      `Projector ${env.PROJECTOR_API_URL} (${env.PROJECTOR_CLIENT_SLUG || "evoke"})`,
  );
  console.log(`Comments imported as ${COMMENTS_INTERNAL ? "INTERNAL notes" : "public comments"}.`);

  const tasks = await clickup.allTasks(env.CLICKUP_LIST_ID);
  console.log(`Found ${tasks.length} ClickUp tasks.`);

  let n = 0;
  for (const task of tasks) {
    if (n >= LIMIT) break;
    n++;
    try {
      await importTask(task);
    } catch (err) {
      stats.errors.push(`${task.id} (${task.name}): ${err.message}`);
      console.error(`  ✗ ${task.name}: ${err.message}`);
    }
    if (n % 25 === 0) console.log(`  …${n}/${tasks.length}`);
  }

  console.log("\n=== Summary ===");
  console.log(`Tasks processed:  ${stats.tasks}`);
  console.log(`  created:        ${stats.tasksCreated}`);
  console.log(`  already existed:${stats.tasksExisting}`);
  console.log(`Comments imported:${stats.comments}`);
  console.log(`Comments skipped: ${stats.commentsSkipped} (unmapped author)`);
  console.log(`Assignees dropped:${stats.assigneesDropped} (unmapped person)`);
  console.log(`Errors:           ${stats.errors.length}`);
  for (const e of stats.errors.slice(0, 20)) console.log(`  ! ${e}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
