import { reviewAddress } from './review-address.js';
import { node, reviewChip } from './review-evidence.js';
import { reviewLink } from './review-navigation.js';

export function renderReviewRows(rows, items, view, openRow) {
  rows.replaceChildren();
  for (const item of items) {
    const tr = node('tr');
    const action = reviewLink(item.preview, () => openRow(item.id));
    action.href = reviewAddress({ ...view, row: item.id });
    action.dataset.rowId = item.id;

    const preview = node('td');
    preview.append(action, node('small', `Row ID: ${item.id}`));
    preview.dataset.label = 'Original notice preview';
    tr.append(
      preview,
      node(
        'td',
        item.bibleNames.slice(0, 3).join(', ') +
          (item.bibleCount > 3 ? ` +${item.bibleCount - 3}` : '')
      ),
      node('td', item.source),
      node('td', item.status),
      node('td'),
      node(
        'td',
        item.sampleCount
          ? `${item.votes.allowed} allowed / ${item.votes.forbidden} forbidden / ${item.votes.unknown} unknown`
          : 'No model votes'
      )
    );
    for (const [cell, label] of [...tr.children]
      .slice(1)
      .map((cell, index) => [
        cell,
        ['Affected Bibles', 'Source', 'Decision', 'Review state', 'Saved model votes'][index],
      ]))
      cell.dataset.label = label;
    tr.children[4].append(reviewChip(item));
    rows.append(tr);
  }
}

export function initReviewPagination(section, goTo, pageAddress) {
  let currentPage = 0;
  const pagers = [...section.querySelectorAll('.review-pager')].map((group) => {
    const previous = group.querySelector('[name="previous"]');
    const next = group.querySelector('[name="next"]');
    const status = group.querySelector('.review-page-status');
    const jump = group.querySelector('.page-jump');
    const input = jump.elements.page;
    const submit = jump.querySelector('button');
    previous.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (previous.hasAttribute('href')) goTo(currentPage - 1);
    });
    next.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (next.hasAttribute('href')) goTo(currentPage + 1);
    });
    jump.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!input.disabled && input.reportValidity()) {
        goTo(input.valueAsNumber);
      }
    });
    const size = group.querySelector('[name=pageSize]');
    size.addEventListener('change', () => goTo(1, Number(size.value)));
    return { size, group, previous, next, status, input, submit };
  });
  let focused = null;

  function show(text, page = 0, pageCount = 0) {
    currentPage = page;
    for (const { previous, next, status, input, submit } of pagers) {
      status.textContent = text;
      for (const [link, enabled] of [
        [previous, page > 1],
        [next, page < pageCount],
      ]) {
        link.setAttribute('aria-disabled', String(!enabled));
        if (enabled) link.href = pageAddress(link === previous ? page - 1 : page + 1);
        else link.removeAttribute('href');
      }
      input.max = String(pageCount);
      input.value = page ? String(page) : '';
      input.disabled = submit.disabled = !pageCount;
    }
  }
  return {
    loading() {
      const active = document.activeElement;
      if (active !== document.body) focused = active?.closest('.review-pager') ? active : null;
      show('Loading results…');
    },
    render({ page, pageCount, pageSize, total, rows }) {
      for (const pager of pagers) pager.size.value = String(pageSize);
      const offset = (page - 1) * pageSize;
      const message = total
        ? `Page ${page} of ${pageCount} · Showing ${offset + 1}–${offset + rows.length} of ${total} results · ${pageSize} per page`
        : `No matching results · ${pageSize} per page`;
      show(message, total ? page : 0, total ? pageCount : 0);
      if (
        focused &&
        (document.activeElement === document.body || document.activeElement === focused)
      ) {
        const pager = pagers.find(({ group }) => group.contains(focused));
        (focused.disabled || focused.getAttribute('aria-disabled') === 'true'
          ? pager.status
          : focused
        ).focus();
      }
      focused = null;
    },
    clear() {
      focused = null;
      show('');
    },
  };
}
