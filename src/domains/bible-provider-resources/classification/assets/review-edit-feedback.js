const noteEditConflict =
  'The decision, reason or reviewer name has an unapplied edit. Apply the reasoned decision or restore those fields before updating only the note.';

export function reviewEditFeedback(status) {
  status.id = 'review-edit-feedback';
  status.tabIndex = -1;
  let invalid;
  let correctionFields = [];

  function clear() {
    if (invalid) {
      const descriptions = (invalid.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((id) => id && id !== status.id);
      if (descriptions.length) invalid.setAttribute('aria-describedby', descriptions.join(' '));
      else invalid.removeAttribute('aria-describedby');
      invalid.removeAttribute('aria-invalid');
      invalid = undefined;
    }
    correctionFields = [];
    status.textContent = '';
  }

  function show(message, control, markInvalid = false, corrections = [control]) {
    status.textContent = message;
    correctionFields = corrections;
    if (markInvalid) {
      invalid = control;
      control.setAttribute('aria-invalid', 'true');
      control.setAttribute(
        'aria-describedby',
        [control.getAttribute('aria-describedby'), status.id].filter(Boolean).join(' ')
      );
    }
    (control ?? status).focus();
  }

  return {
    clear,
    onInput(event) {
      if (correctionFields.includes(event.target)) clear();
    },
    show,
    showNoteConflict(...fields) {
      show(noteEditConflict, undefined, false, fields);
    },
  };
}

export function validateReviewEdit(kind, reviewer, reason, note, feedback) {
  if (kind === 'unknown-note') {
    if (note.value.trim()) return true;
    feedback.show('Enter a note before updating the unknown note.', note, true);
    return false;
  }
  const name = reviewer.value.trim();
  if (!name || name.length > 200) {
    feedback.show('Enter a human reviewer name of 1 to 200 characters.', reviewer, true);
    return false;
  }
  if (reason.value.trim()) return true;
  feedback.show('Enter a reason for the decision.', reason, true);
  return false;
}
