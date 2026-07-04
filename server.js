// Live Jira → Projector bridge. Receives the same Jira webhooks as the
// xml-to-clickup service and mirrors each issue into Projector over the REST
// API. Because Projector upserts are idempotent (external_source + external_id)
// and comments/time are idempotent on their own keys, this needs no local
// snapshot/diff engine — it just (re)asserts the desired state on every hook.

import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { makeProjector } from "./lib/projector.js";
import { taskBody, issueComments, updatedMs, jiraNumber } from "./lib/jira.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- env (dependency-free loader; same shape as scripts/backfill.js) ---
const env = { ...process.env };
try {
  for (const line of readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
} catch {
  /* rely on process.env */
}

const {
  PROJECTOR_API_URL,
  PROJECTOR_API_KEY,
  PROJECTOR_CLIENT_SLUG = "evoke",
  EXTERNAL_SOURCE = "jira",
  BASIC_AUTH_USER,
  BASIC_AUTH_PASSWORD,
  PORT = 38473,
} = env;
const COMMENTS_INTERNAL = String(env.COMMENTS_INTERNAL ?? "true") === "true";

if (!PROJECTOR_API_URL || !PROJECTOR_API_KEY) {
  console.error("Missing PROJECTOR_API_URL or PROJECTOR_API_KEY — copy .env.example to .env.");
  process.exit(1);
}

const projector = makeProjector({
  apiUrl: PROJECTOR_API_URL,
  apiKey: PROJECTOR_API_KEY,
  clientSlug: PROJECTOR_CLIENT_SLUG,
  writeDelayMs: Number(env.WRITE_DELAY_MS || 60),
});

// --- serialise work per Jira key so two webhooks for the same issue can't
// race (e.g. a comment hook creating a second task before issue-created). ---
const chains = new Map();
function serializeByKey(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    key,
    next.catch(() => {}).finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    }),
  );
  return next;
}

// --- drop out-of-order webhooks: Jira can deliver bursts unordered, and an
// older payload would revert a newer state. In-memory high-water mark per key
// (fine for a parallel-run trial; a restart at worst lets one stale update
// through, self-healed by the next real update). ---
const lastUpdated = new Map();

// Upsert the issue's task, then bring mutable fields up to date, then sync
// its comments. Returns the Projector ref.
async function syncIssue(issue) {
  const key = issue.key;
  if (!key) throw new Error("payload has no issue.key");

  const incoming = updatedMs(issue);
  const seen = lastUpdated.get(key) || 0;
  if (incoming && seen && incoming < seen) {
    return { ref: null, action: "stale" };
  }
  if (incoming) lastUpdated.set(key, incoming);

  const body = taskBody(issue, { externalSource: EXTERNAL_SOURCE });
  const res = await projector.upsertTask(body);
  const ref = res.ref;

  // A replayed (existing) task isn't updated by the idempotent create, so
  // re-assert the mutable fields.
  if (res.existing) {
    const patch = {
      title: body.title,
      description: body.description,
      status: body.status,
    };
    if (body.due_date) patch.due_date = body.due_date;
    if (body.assignees) patch.assignees = body.assignees;
    await projector.patchTask(ref, patch);
  }

  // Comments — idempotent on jira:comment:<id> (the same key the ClickUp
  // mirror used, so nothing double-posts).
  let posted = 0;
  for (const c of issueComments(issue)) {
    if (!c.bodyMd) continue;
    await projector.importComment(ref, {
      body: c.bodyMd,
      ...(c.authorEmail ? { author: c.authorEmail } : {}),
      ...(c.created ? { created_at: c.created } : {}),
      external_id: `jira:comment:${c.id}`,
      internal: COMMENTS_INTERNAL,
    });
    posted++;
  }
  return { ref, action: res.existing ? "updated" : "created", posted };
}

// --- HTTP ---
const app = express();
app.use(express.json({ limit: "10mb" }));

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function basicAuth(req, res, next) {
  if (!BASIC_AUTH_USER && !BASIC_AUTH_PASSWORD) return next(); // unset = open (dev)
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (safeEqual(user, BASIC_AUTH_USER) && safeEqual(pass, BASIC_AUTH_PASSWORD)) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="jira-to-projector"');
  return res.status(401).send("Authentication required");
}

app.get("/health", (_req, res) => res.json({ ok: true }));

async function handle(req, res) {
  const issue = req.body || {};
  const key = issue.key || "?";
  try {
    const out = await serializeByKey(key, () => syncIssue(issue));
    console.log(`[${req.path}] ${key} → ${out.action} ${out.ref || ""} comments=${out.posted ?? 0}`);
    res.json({ ok: true, ref: out.ref, action: out.action, posted: out.posted ?? 0 });
  } catch (err) {
    console.error(`[${req.path}] ${key}:`, err.message);
    res.status(500).json({ error: err.message });
  }
}

app.use(basicAuth);
app.post("/jira/issue-created", handle);
app.post("/jira/issue-updated", handle);
app.post("/jira/comment-added", handle);

app.listen(PORT, () => {
  console.log(`jira-to-projector on :${PORT} → ${PROJECTOR_API_URL} (${PROJECTOR_CLIENT_SLUG})`);
  console.log(`Comments as ${COMMENTS_INTERNAL ? "internal notes" : "public comments"}.`);
});

export { syncIssue }; // for tests / dry harness
