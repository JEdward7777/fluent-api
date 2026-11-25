// Keep each immutable command until its acknowledgement. Retrying a lost reply uses
// the same mutation ID even when newer keystrokes are already waiting.
export function createDraftSync(
  item,
  { send, values, dirty, feedback, acknowledged, rebaseFields }
) {
  let generation = 0;
  let kept = 0;
  const changedAt = new Map();
  let timer;
  let pending;
  let running;
  let failed = false;
  let conflict;
  let action;
  function schedule(field) {
    generation++;
    changedAt.set(field, generation);
    dirty(true);
    clearTimeout(timer);
    if (!failed) {
      feedback('Syncing…');
      timer = setTimeout(flush, 300);
    }
  }
  function snapshot() {
    return { generation, values: values(), changedAt: new Map(changedAt) };
  }
  function patch(snapshot) {
    const edit = { kind: 'patch', touched: true };
    for (const [field, value] of Object.entries(snapshot.values)) {
      if (snapshot.changedAt.get(field) > kept && value !== (item[field] ?? null))
        edit[field] = value;
    }
    return edit;
  }
  async function drain() {
    while (pending || kept < generation || action) {
      if (!pending) {
        // The action separates earlier inputs from typing that followed its click.
        const before = action?.before ?? snapshot();
        const edit = kept < before.generation ? patch(before) : action.command;
        pending = {
          generation: before.generation,
          body: {
            ...edit,
            epoch: item.epoch,
            id: item.id,
            contentRevision: item.contentRevision,
            mutationId: crypto.randomUUID(),
          },
        };
      }
      const { body } = pending;
      try {
        const ack = await send(body);
        Object.assign(item, ack.values, { contentRevision: ack.contentRevision });
        await acknowledged(
          ack,
          body.kind,
          (field) => (changedAt.get(field) ?? 0) <= pending.generation
        );
        if (body.kind === 'patch') kept = pending.generation;
        else action = undefined;
        pending = undefined;
      } catch (error) {
        failed = true;
        if (error.status === 409) {
          try {
            conflict = JSON.parse(error.message);
          } catch {
            conflict = {};
          }
        }
        const server = conflict?.values;
        if (server && conflict.epoch === item.epoch)
          rebaseFields(
            server,
            (field) =>
              !Object.hasOwn(body, field) && (changedAt.get(field) ?? 0) <= pending.generation
          );

        feedback(
          server
            ? `Review changed. Current session decision: ${server.status}. Comment: ${server.reviewComment ?? '(none)'}. Retry to apply your edit.`
            : `Could not sync. ${conflict ? 'This row is unavailable.' : error.message}`,
          true,
          Boolean(conflict)
        );
        return false;
      }
    }
    clearTimeout(timer);
    dirty(false);
    feedback(item.pending ? 'Kept in session · awaiting Save' : 'No pending edit');
    return true;
  }
  function flush() {
    clearTimeout(timer);
    if (failed) return Promise.resolve(false);
    running ??= drain().finally(() => {
      running = undefined;
    });
    return running;
  }
  return {
    schedule,
    flush,
    get generation() {
      return generation;
    },
    get hasLocalIntent() {
      return (
        kept < generation || action?.command.kind === 'mark' || action?.command.kind === 'mark-next'
      );
    },
    async command(command) {
      if (action || failed) return false;
      action = { command, before: snapshot() };
      dirty(true);
      feedback('Syncing…');
      return flush();
    },
    retry() {
      if (conflict) {
        if (conflict.epoch !== item.epoch || !conflict.values || !pending) return;
        pending.body = {
          ...pending.body,
          contentRevision: conflict.contentRevision,
          mutationId: crypto.randomUUID(),
        };
        conflict = undefined;
      }
      failed = false;
      feedback('Syncing…');
      return flush();
    },
  };
}

export function reviewShortcuts({ back, decision, change, mark, next, revert, move }) {
  return (event) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.repeat ||
      event.altKey ||
      event.metaKey ||
      document.querySelector('dialog[open], [aria-modal="true"]:not([hidden])')
    )
      return;
    const key = event.key.toLowerCase();
    if (key === 'escape' && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      void back();
      return;
    }
    if (
      event.target.closest?.('textarea,input,select,[contenteditable]:not([contenteditable=false])')
    )
      return;
    if (event.ctrlKey && !event.shiftKey && key === 'backspace') {
      event.preventDefault();
      revert.click();
      return;
    }
    if (event.ctrlKey) return;
    if (event.shiftKey) {
      if (key === 'enter') {
        event.preventDefault();
        next.click();
      }
      return;
    }
    const choice = { a: 'allowed', f: 'forbidden', u: 'unknown' }[key];
    if (choice && !decision.disabled) {
      event.preventDefault();
      if (decision.value !== choice) {
        decision.value = choice;
        change();
      }
    }
    if (['j', 'k', 'r'].includes(key)) {
      event.preventDefault();
      if (key === 'r') mark.click();
      else void move(key === 'j' ? 'nextId' : 'previousId');
    }
  };
}
