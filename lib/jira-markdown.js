// Pure Jira-wiki-markup -> Markdown conversion, extracted so it can be unit-
// tested / dry-run over saved payloads without booting the Express server.
// No I/O, no env, no side effects.

// Jira custom field IDs rendered at the top of the ClickUp description.
export const JIRA_FIELD_LABELS = {
  customfield_11049: 'Brand',
  customfield_10776: 'Territory',
  customfield_11235: 'Channels',
};

// Jira "option" custom fields can be a single object, an array of objects,
// a string, or a number. Reduce them to a comma-separated display string.
export function extractFieldValue(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(extractFieldValue).filter(Boolean).join(', ');
  if (typeof v === 'object') return v.value != null ? String(v.value) : '';
  return String(v);
}

function renderJiraMention(accountId, users) {
  const u = users[accountId];
  if (u?.mm) return `@${u.mm}`;
  if (u?.name) return `**@${u.name}**`;
  return '`@user`';
}

// Convert Jira wiki markup -> Markdown for Mattermost/ClickUp.
// Handles the subset that actually appears in Jira comments/descriptions.
// `users` maps Jira accountId -> { name, mm } for rendering mentions.
export function jiraToMarkdown(text, users = {}) {
  if (!text) return '';
  let s = String(text);

  // Fenced blocks first so their contents aren't touched by later replacements.
  s = s.replace(/\{code(?::([^}]+))?\}([\s\S]*?)\{code\}/g,
    (_, lang, body) => '```' + (lang || '') + '\n' + body.replace(/^\n|\n$/g, '') + '\n```');
  s = s.replace(/\{noformat\}([\s\S]*?)\{noformat\}/g,
    (_, body) => '```\n' + body.replace(/^\n|\n$/g, '') + '\n```');
  s = s.replace(/\{quote\}([\s\S]*?)\{quote\}/g,
    (_, body) => body.trim().split('\n').map(l => '> ' + l).join('\n'));
  s = s.replace(/\{color:[^}]*\}([\s\S]*?)\{color\}/g, (_, body) => body);

  // Mentions
  s = s.replace(/\[~accountid:([^\]]+)\]/g, (_, id) => renderJiraMention(id, users));
  s = s.replace(/\[~([^\]]+)\]/g, (_, name) => `@${name}`);

  // Links: [text|url|decoration], [text|url], [url]
  s = s.replace(/\[([^|\]\n]*)\|([^|\]\n]+)\|[^\]\n]*\]/g, (_, t, url) => {
    const label = t.trim();
    return label && label !== url ? `[${label}](${url})` : url;
  });
  // The label may itself open with an underline marker and/or a bracketed token
  // (a Jira key cross-reference, e.g. "[+[CRTR-18] foo+|url]"); allow an optional
  // leading '+' and one leading [..] group, but no other bare ']' so we don't
  // swallow a separate "[not a link]" earlier on the line. Surrounding underline
  // '+' markers are stripped from the label since the later underline pass can't
  // reach inside an already-formed link.
  s = s.replace(/\[(\+?(?:\[[^\]\n]*\])?[^|\]\n]*)\|([^\]\n]+)\]/g, (_, t, url) => {
    const label = t.trim().replace(/^\++|\++$/g, '').trim();
    return label && label !== url ? `[${label}](${url})` : url;
  });
  s = s.replace(/\[((?:https?|ftp):\/\/[^\]\s]+)\]/g, (_, url) => url);

  // Headings h1. ... h6.
  s = s.replace(/^h([1-6])\.\s*(.+)$/gm, (_, n, t) => `${'#'.repeat(Number(n))} ${t}`);

  // Inline: monospace, bold, italic
  s = s.replace(/\{\{([^}\n]+)\}\}/g, (_, t) => `\`${t}\``);
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, (_, pre, t) => `${pre}**${t}**`);
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, (_, pre, t) => `${pre}*${t}*`);

  // Underline +text+ -> drop the markers (Markdown has no underline), keep the
  // inner text. Runs after bold/italic so e.g. "+*Offer:*+" -> "**Offer:**".
  // The markers must hug the text (no whitespace just inside), so literal plus
  // signs in offers like "€20 + 100%" or "50€ + 50 FS" are left untouched.
  s = s.replace(/(^|[^+\w])\+([^+\s\n](?:[^+\n]*[^+\s\n])?)\+(?=[^+\w]|$)/g, (_, pre, t) => `${pre}${t}`);

  return s;
}

export function buildDescription(fields, users = {}) {
  const meta = Object.entries(JIRA_FIELD_LABELS)
    .map(([id, label]) => {
      const val = extractFieldValue(fields[id]);
      return val ? `**${label}:** ${val}` : '';
    })
    .filter(Boolean)
    .join('  \n');

  const body = jiraToMarkdown((fields.description || '').toString(), users).trim();
  return [meta, body].filter(Boolean).join('\n\n---\n\n');
}
