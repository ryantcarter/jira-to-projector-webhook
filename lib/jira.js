// Jira payload helpers, shared by the live webhook server. Pure, no I/O.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDescription, jiraToMarkdown } from "./jira-markdown.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const statusCfg = JSON.parse(
  readFileSync(path.join(root, "config", "jira-status-map.json"), "utf8"),
);
const identity = JSON.parse(
  readFileSync(path.join(root, "config", "jira-identity-map.json"), "utf8"),
);
let jiraUsers = {};
try {
  jiraUsers = JSON.parse(readFileSync(path.join(root, "jira-users.json"), "utf8"));
} catch {
  /* mentions just render less nicely without it */
}

// "CRTR-220" → 220 (numeric suffix) or null.
export function jiraNumber(key) {
  const m = /(\d+)\s*$/.exec(String(key || ""));
  return m ? Number(m[1]) : null;
}

export function mapStatus(name) {
  return statusCfg.map[(name || "").toLowerCase()] || statusCfg.default;
}

// A Jira issue's human browse URL, derived from its API `self` link.
export function browseUrl(issue) {
  if (!issue.self || !issue.key) return "";
  return issue.self.replace(/\/rest\/api\/\d+\/issue\/.*$/, `/browse/${issue.key}`);
}

// Resolve a Jira actor { accountId, displayName, emailAddress } to a Projector
// staff email, or null if we can't place them.
export function resolveEmail(actor) {
  if (!actor) return null;
  const email = (actor.emailAddress || "").toLowerCase();
  if (email && identity.knownEmails.includes(email)) return email;
  const name = (actor.displayName || "").toLowerCase();
  return identity.byName[name] || null;
}

// Build the Projector task body from a Jira issue payload.
export function taskBody(issue, { externalSource = "jira" } = {}) {
  const fields = issue.fields || {};
  const key = issue.key;
  const summary = (fields.summary || "").toString();
  const url = browseUrl(issue);
  const assigneeEmail = resolveEmail(fields.assignee);
  return {
    title: `[${key}] ${summary}`.trim(),
    description: buildDescription(fields, jiraUsers),
    status: mapStatus(fields.status?.name),
    ...(fields.duedate ? { due_date: fields.duedate } : {}),
    ...(assigneeEmail ? { assignees: [assigneeEmail] } : {}),
    external_source: externalSource,
    external_id: key,
    ...(jiraNumber(key) ? { ref_number: jiraNumber(key) } : {}),
    fields: {
      "Jira ID": key,
      ...(url ? { "Jira URL": url } : {}),
    },
  };
}

// Normalise the issue's comment list into { id, author, created, bodyMd }.
export function issueComments(issue) {
  const raw = issue.fields?.comment?.comments || [];
  return raw.map((c) => ({
    id: String(c.id),
    authorEmail: resolveEmail(c.author),
    created: c.created ? new Date(c.created).toISOString() : undefined,
    bodyMd: jiraToMarkdown((c.body || "").toString(), jiraUsers).trim(),
  }));
}

// The `updated` timestamp used to drop out-of-order webhooks.
export function updatedMs(issue) {
  return Number(issue.fields?.updated) || Date.parse(issue.fields?.updated) || 0;
}
