// Dry smoke test: run the Jira→Projector mapping over the saved sample
// webhook payloads and print what WOULD be sent. No network, no writes — the
// actual HTTP path is exercised by scripts/backfill.js against the live API.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taskBody, issueComments, updatedMs, mapPriority, PRIORITY_FIELD } from "../lib/jira.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "..", "samples");

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const issue = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  console.log(`\n=== ${file} ===`);
  const body = taskBody(issue);
  console.log("task:", JSON.stringify({
    ref_number: body.ref_number,
    external_id: body.external_id,
    title: body.title,
    status: body.status,
    due_date: body.due_date,
    assignees: body.assignees,
    fields: body.fields,
  }, null, 2));
  console.log("description (first 120):", body.description.slice(0, 120).replace(/\n/g, " "));
  console.log(
    `priority: jira "${issue.fields?.priority?.name ?? "(none)"}" -> ` +
      `${PRIORITY_FIELD}="${body.fields[PRIORITY_FIELD]}"`,
  );
  const comments = issueComments(issue);
  console.log(`comments: ${comments.length}`);
  for (const c of comments) {
    console.log(
      `  jira:comment:${c.id} author=${c.authorEmail || "(unresolved→key person)"} ` +
        `"${c.bodyMd.slice(0, 50).replace(/\n/g, " ")}"`,
    );
  }
  console.log("updatedMs:", updatedMs(issue));
}
// The priority map covers far more Jira names than the samples exercise, and
// an unmapped one would silently become the default in production — so assert
// the whole table here, where it's cheap.
console.log("\n=== priority map ===");
const priorityCases = [
  ["Urgent", "Urgent"],
  ["Blocker", "Urgent"],
  ["High", "High"],
  ["Major", "High"],
  ["Major (migrated)", "High"],
  ["Medium", "Medium"],
  ["P3", "Medium"],
  ["Low", "Low"],
  ["Trivial", "Low"],
  ["Unspecified", ""],
  ["Not Set", ""],
  [undefined, ""],
];
let failures = 0;
for (const [input, expected] of priorityCases) {
  const got = mapPriority(input);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok" : "FAIL"}  "${input ?? "(none)"}" -> "${got}"${ok ? "" : ` (expected "${expected}")`}`);
}
// An unknown name must fall back rather than throw — a value outside the
// dropdown's options would 422 the whole task update.
const unknown = mapPriority("DAML");
console.log(`  ${unknown === "Medium" ? "ok" : "FAIL"}  unknown "DAML" -> "${unknown}" (warned above)`);
if (unknown !== "Medium") failures++;

if (failures) {
  console.error(`\n${failures} priority mapping failure(s).`);
  process.exit(1);
}
console.log("\nOK — mapping ran over all samples with no errors.");
