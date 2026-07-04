// ClickUp read side. Thin wrapper over the v2 REST API with a courteous
// throttle to stay comfortably under the 100 req/min limit.

const API = "https://api.clickup.com/api/v2";

let lastCall = 0;
const MIN_GAP_MS = 700; // ~85 req/min ceiling

async function throttle() {
  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

export function makeClickup(token) {
  async function cu(path) {
    await throttle();
    const res = await fetch(API + path, { headers: { Authorization: token } });
    if (res.status === 429) {
      // Rate limited — back off and retry once.
      await new Promise((r) => setTimeout(r, 5000));
      return cu(path);
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`ClickUp ${res.status} ${path}: ${JSON.stringify(data)}`);
    }
    return data;
  }

  return {
    // Every task on the list, across all pages, closed + subtasks included.
    async allTasks(listId) {
      const out = [];
      for (let page = 0; ; page++) {
        const d = await cu(
          `/list/${listId}/task?include_closed=true&subtasks=true&page=${page}`,
        );
        const tasks = d.tasks || [];
        out.push(...tasks);
        if (d.last_page || tasks.length === 0) break;
      }
      return out;
    },

    // Comments on a task, oldest first (ClickUp returns newest first).
    async taskComments(taskId) {
      const d = await cu(`/task/${taskId}/comment`);
      return (d.comments || []).slice().reverse();
    },

    // The workspace and its member user ids. The time-entries endpoint only
    // returns the caller's own time unless every member is named in
    // `assignee`, so we always pass the full list.
    async team() {
      const d = await cu("/team");
      const t = d.teams[0];
      return { id: t.id, memberIds: (t.members || []).map((m) => m.user.id) };
    },

    // Every time entry for the given members in the window. ClickUp returns
    // the whole workspace's entries; the caller filters to the tasks it cares
    // about. `duration` is ms (negative for a live-running timer — skip those).
    async timeEntries(teamId, memberIds, startMs, endMs) {
      const d = await cu(
        `/team/${teamId}/time_entries?start_date=${startMs}&end_date=${endMs}` +
          `&assignee=${memberIds.join(",")}`,
      );
      return d.data || [];
    },
  };
}

// Pull a named custom field's value off a ClickUp task (or null).
export function customField(task, name) {
  const f = (task.custom_fields || []).find(
    (c) => c.name === name && c.value !== undefined && c.value !== null,
  );
  return f ? f.value : null;
}
