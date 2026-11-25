import { expect, it, vi } from 'vitest';

import { createDraftSync } from './assets/review-edit-feedback.js';
import { initReviewNavigation } from './assets/review-navigation.js';

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each(['revert', 'mark', 'mark-next'])(
  'keeps typing after a queued %s separate from earlier inputs',
  async (kind) => {
    const item = {
      id: 'row',
      epoch: 'session',
      contentRevision: 1,
      status: 'unknown',
      reviewComment: null,
    };
    const controls = { status: item.status, reviewComment: item.reviewComment };
    const entered = gate();
    const response = gate();
    const stored = { ...controls };
    const commands = [];
    const sync = createDraftSync(item, {
      dirty: vi.fn(),
      feedback: vi.fn(),
      values: () => ({ ...controls }),
      async send(body) {
        commands.push(body.kind);
        if (commands.length === 1) {
          entered.release();
          await response.promise;
        }
        if (body.kind === 'revert')
          Object.assign(stored, { status: 'unknown', reviewComment: null });
        for (const field of Object.keys(controls))
          if (Object.hasOwn(body, field)) stored[field] = body[field];
        return { contentRevision: body.contentRevision + 1, values: { ...stored } };
      },
      async acknowledged(ack, kind, unchanged) {
        for (const field of Object.keys(controls))
          if (unchanged(field)) controls[field] = ack.values[field];
      },
    });
    controls.reviewComment = 'first';
    sync.schedule('reviewComment');
    const first = sync.flush();
    await entered.promise;
    controls.status = 'allowed';
    sync.schedule('status');
    const action = sync.command({ kind });
    controls.reviewComment = 'after click';
    sync.schedule('reviewComment');
    response.release();
    expect(await first).toBe(true);
    expect(await action).toBe(true);
    expect(commands).toEqual(['patch', 'patch', kind, 'patch']);
    expect(controls).toEqual({
      status: kind === 'revert' ? 'unknown' : 'allowed',
      reviewComment: 'after click',
    });
    expect(stored).toEqual(controls);
  }
);

it('consumes one navigation intent while the row acknowledgement is outstanding', async () => {
  const window = new EventTarget();
  const history = {
    state: null,
    pushState: vi.fn(function (state) {
      this.state = structuredClone(state);
    }),
    replaceState(state) {
      this.state = structuredClone(state);
    },
    go: vi.fn(),
  };
  const field = () => Object.assign(new EventTarget(), { value: 'all' });
  const form = Object.assign(new EventTarget(), {
    elements: { search: field(), status: field(), source: field(), reviewState: field() },
  });
  vi.stubGlobal('window', window);
  vi.stubGlobal('history', history);
  vi.stubGlobal('location', new URL('http://localhost/?stage=review'));
  try {
    const response = gate();
    const navigation = initReviewNavigation(form, vi.fn(), () => response.promise);
    navigation.sync({ launchId: crypto.randomUUID(), loadRevision: 1, analysis: {} });
    await navigation.openRow('a'.repeat(64));
    navigation.setDirty(true);
    const first = navigation.openRow(() => 'b'.repeat(64));
    const duplicate = navigation.openRow(() => 'b'.repeat(64));
    const stage = navigation.pushStage('?stage=save');
    expect(history.pushState).toHaveBeenCalledTimes(1);
    navigation.setDirty(false);
    response.release(true);
    expect(await Promise.all([first, duplicate, stage])).toEqual([true, false, false]);
    expect(history.pushState).toHaveBeenCalledTimes(2);
    expect(history.state.licenseReviewNavigationV2.row).toBe('b'.repeat(64));
  } finally {
    vi.unstubAllGlobals();
  }
});
