// Dry smoke test: run the Jira→Projector mapping over the saved sample
// webhook payloads and print what WOULD be sent. No network, no writes — the
// actual HTTP path is exercised by scripts/backfill.js against the live API.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taskBody, issueComments, updatedMs } from "../lib/jira.js";

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
console.log("\nOK — mapping ran over all samples with no errors.");
