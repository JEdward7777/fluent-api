import { expect, it, vi } from 'vitest';

import { createEstimateRefresh } from './assets/estimate-refresh.js';
import { readReview, reviewAddress } from './assets/review-address.js';
import { createDraftSync, reviewShortcuts } from './assets/review-edit-feedback.js';
import { initReviewNavigation } from './assets/review-navigation.js';
import { createSaveSettings } from './assets/save-settings.js';

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

it.each(['disjoint', 'conflicting', 'retargeted', 'reselected'])(
  'rebases only locally edited AI fields after %s changes in another tab',
  async (mode) => {
    vi.useFakeTimers();
    const retry = new EventTarget();
    const scopeNotice = {};
    vi.stubGlobal('document', {
      getElementById: (id) => (id === 'retry-estimate' ? retry : scopeNotice),
    });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    let current = {
      state: 'reviewing',
      analysis: {},
      paidEstimate: {},
      configurationRevision: 1,
      estimateRevision: 1,
      loadRevision: 1,
      contentRevision: 1,
      selectedModelId: 'row',
      reassessmentScopeRevision: 1,
      model: 'google:original',
      sampleCount: 3,
      noCache: false,
      cacheDir: null,
    };
    const remote = {
      ...current,
      model: 'google:updated',
      configurationRevision: 2,
      estimateRevision: 2,
      sampleCount: ['conflicting', 'retargeted'].includes(mode) ? 5 : 3,
      selectedModelId: mode === 'retargeted' ? 'new-row' : current.selectedModelId,
      reassessmentScopeRevision: ['retargeted', 'reselected'].includes(mode) ? 3 : 1,
    };
    const restoreAi = vi.fn();
    const request = vi.fn(async (path, _method, body) => {
      if (path === 'setup') return remote;
      if (body.configurationRevision === 1) throw new Error('Configuration changed');
      return { ...remote, ...body, configurationRevision: 3, estimateRevision: 3 };
    });
    try {
      const refresh = createEstimateRefresh({
        getSetup: () => current,
        // This tab only touched Samples. Its old model must never be posted against the new revision.
        read: () => ({ ...current, model: 'google:original', sampleCount: 4 }),
        dirty: () => false,
        restoreAi,
        available: () => true,
        sync: () => refresh.message(),
        render: (next) => {
          refresh.rebase(next);
          current = next;
        },
        request,
      });
      refresh.change('samples');
      await vi.advanceTimersByTimeAsync(1000);
      if (['retargeted', 'reselected'].includes(mode)) {
        expect(restoreAi).toHaveBeenCalledWith(remote);
        expect(refresh.edited).toBe(false);
        expect(scopeNotice.textContent).toContain('Pending AI settings for row row were cleared.');
        expect(scopeNotice.textContent).toContain(
          `current estimate is for row ${remote.selectedModelId}.`
        );
        expect(retry.hidden).toBe(true);
        retry.dispatchEvent(new Event('click'));
        await vi.advanceTimersByTimeAsync(500);
        expect(request).toHaveBeenCalledTimes(2);
        return;
      }
      expect(restoreAi).not.toHaveBeenCalled();
      if (mode === 'conflicting') {
        expect(request).toHaveBeenCalledTimes(2);
        expect(current.sampleCount).toBe(5);
        expect(refresh.message()).toContain(
          'Samples changed to 5 in the session. Your form shows 4'
        );
        expect(retry.hidden).toBe(false);
        retry.dispatchEvent(new Event('click'));
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(request).toHaveBeenCalledTimes(3);
      expect(request).toHaveBeenLastCalledWith(
        'ai/estimate',
        'POST',
        expect.objectContaining({
          configurationRevision: 2,
          estimateRevision: 2,
          model: 'google:updated',
          sampleCount: 4,
        })
      );
      expect(refresh.blocked).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  }
);

it('transfers only review navigation through a shared address and a delayed source load', () => {
  const row = 'a'.repeat(64);
  const query = new URLSearchParams({
    stage: 'review',
    row,
    search: 'filtered & paged',
    source: 'rule',
    status: 'unknown',
    reviewState: 'unreviewed',
    page: '3',
    pageSize: '10',
    password: 'discard',
    reviewComment: 'unpublished',
    token: 'discard',
  });
  const location = new URL(`http://localhost/?${query}`);
  const history = {
    state: null,
    replaceState(state, _, url) {
      this.state = structuredClone(state);
      location.href = new URL(url, location);
    },
  };
  const field = () => new EventTarget();
  const form = Object.assign(field(), {
    elements: { search: field(), status: field(), source: field(), reviewState: field() },
  });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', history);
  try {
    const navigation = initReviewNavigation(form, vi.fn(), vi.fn());
    const launchId = crypto.randomUUID();
    const cold = navigation.sync({ launchId, loadRevision: 1 });
    expect(cold).toMatchObject({ row, search: 'filtered & paged', pageSize: 10, page: 3 });
    for (const key of ['password', 'reviewComment', 'token'])
      expect(location.searchParams.has(key)).toBe(false);
    for (const key of ['row', 'status', 'reviewState', 'pageSize', 'page', 'source', 'search'])
      expect(location.searchParams.get(key)).toBe(query.get(key));
    const loaded = navigation.sync({ launchId, loadRevision: 2, analysis: {} });
    expect(loaded.row).toBe(row);
    const replaced = navigation.sync({ launchId, loadRevision: 3, analysis: {} });
    expect(replaced.row).toBeNull();
    expect(location.search).toBe('?stage=review');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('warns only with recognized invalid field names when cleaning a shared review address', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const params = new URLSearchParams({
      stage: 'review',
      search: 'good filter',
      status: 'private comment',
      page: 'secret',
      row: 'invalid-credential',
      password: 'sensitive',
    });
    expect(reviewAddress(readReview(params))).toBe('?stage=review&search=good+filter');
    expect(warn.mock.calls).toEqual([
      ['Ignoring invalid review address field: status'],
      ['Ignoring invalid review address field: page'],
      ['Ignoring invalid review address field: row'],
    ]);
  } finally {
    warn.mockRestore();
  }
});

it('reserves Shift+Enter in the comment and permission fields while preserving native editing', () => {
  const field = () => {
    const element = { closest: () => element };
    return element;
  };
  const comment = field();
  const decision = field();
  const next = { click: vi.fn() };
  let modal = false;
  vi.stubGlobal('document', { querySelector: () => modal });
  try {
    const shortcut = reviewShortcuts({ comment, decision, next });
    function press(target, key, modifiers = {}) {
      const preventDefault = vi.fn();
      shortcut({ key, target, preventDefault, ...modifiers });
      return preventDefault.mock.calls.length;
    }
    for (const target of [comment, decision]) {
      expect(press(target, 'Enter', { shiftKey: true })).toBe(1);
      expect(press(target, 'Enter')).toBe(0);
      expect(press(target, 'r')).toBe(0);
      expect(press(target, 'Backspace', { ctrlKey: true })).toBe(0);
      for (const guard of [
        { ctrlKey: true },
        { repeat: true },
        { isComposing: true },
        { keyCode: 229 },
      ])
        expect(press(target, 'Enter', { shiftKey: true, ...guard })).toBe(0);
    }
    modal = true;
    expect(press(comment, 'Enter', { shiftKey: true })).toBe(0);
    modal = false;
    expect(press(field(), 'Enter', { shiftKey: true })).toBe(0);
    expect(next.click).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('uses the latest destination revision after the previous local edit was undone', () => {
  const controls = new Map();
  vi.stubGlobal('document', {
    getElementById(id) {
      if (!controls.has(id)) controls.set(id, { addEventListener: vi.fn() });
      return controls.get(id);
    },
  });
  try {
    const setup = { destinationRevision: 1, output: 'original.json' };
    const form = { elements: { destination: { value: 'json' }, output: { value: setup.output } } };
    const settings = createSaveSettings({
      getSetup: () => setup,
      form,
      available: () => false,
      drafts: {
        pending: () => form.elements.output.value !== setup.output,
        conflicted: () => false,
      },
    });
    const edit = (value) => {
      form.elements.output.value = value;
      settings.change('output');
    };
    edit('abandoned.json');
    edit('original.json');
    setup.output = form.elements.output.value = 'other-tab.json';
    setup.destinationRevision++;
    settings.schedule();
    edit('new-local.json');
    expect(settings.message()).toBe('');
    expect(controls.get('current-save-settings').hidden).toBe(true);
    setup.output = 'concurrent-change.json';
    setup.destinationRevision++;
    settings.schedule();
    expect(settings.message()).toContain('changed in another tab');
    expect(controls.get('current-save-settings').hidden).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
