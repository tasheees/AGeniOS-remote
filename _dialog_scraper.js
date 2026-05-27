(function() {
  var btns = Array.from(document.querySelectorAll('button[data-tooltip-id]'));
  var skipBtn = null, submitBtn = null;
  for (var i = 0; i < btns.length; i++) {
    var t = (btns[i].innerText || btns[i].textContent || '').trim();
    if (!skipBtn   && /^skip$/i.test(t))   skipBtn   = btns[i];
    if (!submitBtn && /^submit/i.test(t)) submitBtn = btns[i];
  }
  if (!skipBtn || !submitBtn) return null;

  // Step 1: find the lowest ancestor containing both Skip + Submit (the button row)
  var el = skipBtn.parentElement;
  while (el && el !== document.body) {
    if (el.contains(submitBtn)) break;
    el = el.parentElement;
  }
  if (!el || el === document.body) return null;

  // Step 2: walk UP conservatively — stop at first container with real content
  // (title + options), but not so far we capture unrelated page elements.
  var BUTTON_ONLY_RE = /^[\s\n]*(skip|submit|\u21b5)[\s\n]*$/i;
  var current = el;
  for (var up = 0; up < 8; up++) {
    var parent = current.parentElement;
    if (!parent || parent === document.body) break;
    var text = (parent.innerText || '').trim();
    if (text.length > 30 && !BUTTON_ONLY_RE.test(text)) {
      el = parent;
      break;
    }
    current = parent;
  }

  // Step 3: find command text — look for <pre> or <code> in el first,
  // then search up to 4 more parent levels (command block may be a sibling container).
  var codeEl = el.querySelector('pre, code, kbd');
  if (!codeEl) {
    var searchEl = el.parentElement;
    for (var s = 0; s < 4 && searchEl && searchEl !== document.body; s++) {
      codeEl = searchEl.querySelector('pre, code, kbd');
      if (codeEl) break;
      searchEl = searchEl.parentElement;
    }
  }

  return {
    fullText: el ? (el.innerText || '') : '',
    command:  codeEl ? (codeEl.innerText || '').trim() : '',
    skipId:   skipBtn.getAttribute('data-tooltip-id'),
    submitId: submitBtn.getAttribute('data-tooltip-id')
  };
})()
