// Projector write side. Thin wrapper over the public REST API (/api/v1),
// using an admin bearer key so it can address every board and attribute
// comments/time to any staff member.

export function makeProjector({ apiUrl, apiKey, clientSlug, writeDelayMs = 120 }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };

  let last = 0;
  async function pace() {
    const wait = writeDelayMs - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  }

  async function call(method, path, body) {
    await pace();
    const res = await fetch(apiUrl + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = data?.error || text || res.statusText;
      const err = new Error(`Projector ${res.status} ${method} ${path}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, data };
  }

  return {
    // Idempotent on external_source + external_id: a replay returns the
    // existing task (200) instead of creating a duplicate (201).
    async upsertTask(task) {
      const { data } = await call(
        "POST",
        `/clients/${clientSlug}/tasks`,
        task,
      );
      return data; // { ref, id, url, existing? }
    },

    // Update status/title/etc on an existing task by ref.
    async patchTask(ref, patch) {
      return (await call("PATCH", `/tasks/${ref}`, patch)).data;
    },

    // Import a comment: author (email), created_at, external_id (idempotent).
    async importComment(ref, comment) {
      return (await call("POST", `/tasks/${ref}/comments`, comment)).data;
    },

    // Import a time entry (idempotent on external_id).
    async importTime(ref, entry) {
      return (await call("POST", `/tasks/${ref}/time`, entry)).data;
    },
  };
}
