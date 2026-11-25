export function initReviewPagination(section, goTo) {
  let currentPage = 0;
  const pagers = [...section.querySelectorAll('.review-pager')].map((group) => {
    const previous = group.querySelector('[name="previous"]');
    const next = group.querySelector('[name="next"]');
    const status = group.querySelector('.review-page-status');
    const jump = group.querySelector('.page-jump');
    const input = jump.elements.page;
    const submit = jump.querySelector('button');
    previous.addEventListener('click', (event) => {
      event.preventDefault();
      if (previous.hasAttribute('href')) goTo(currentPage - 1);
    });
    next.addEventListener('click', (event) => {
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
        if (enabled) link.href = '?stage=review';
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
