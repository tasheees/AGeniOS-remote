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

  // Step 2: keep walking UP until the element's text has meaningful content
  // beyond just the button labels. This captures the full dialog (title + options),
  // not just the footer row that contains Skip/Submit.
  var BUTTON_ONLY_RE = /^[\s\n]*(skip|submit|\u21b5)[\s\n]*$/i;
  var current = el;
  for (var up = 0; up < 8; up++) {
    var parent = current.parentElement;
    if (!parent || parent === document.body) break;
    var text = (parent.innerText || '').trim();
    // Stop walking once we have real content (more than just button labels)
    if (text.length > 30 && !BUTTON_ONLY_RE.test(text)) {
      el = parent;
      break;
    }
    current = parent;
  }

  var codeEl = el ? el.querySelector('pre, code') : null;
  return {
    fullText: el ? (el.innerText || '') : '',
    command:  codeEl ? (codeEl.innerText || '') : '',
    skipId:   skipBtn.getAttribute('data-tooltip-id'),
    submitId: submitBtn.getAttribute('data-tooltip-id')
  };
})()
