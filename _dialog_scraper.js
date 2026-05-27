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

  // Step 2: walk UP to find the outermost dialog container.
  // Keep updating bestEl as we go — stop when text gets too large (we've left the dialog)
  // or we hit body/html. This captures the full dialog including the command block.
  var bestEl = el;
  var current = el;
  for (var up = 0; up < 12; up++) {
    var parent = current.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    var text = (parent.innerText || '').trim();
    if (text.length > 2000) break; // too much content — we've left the dialog
    if (text.length > 30)  bestEl = parent; // valid dialog container — keep going up
    current = parent;
  }
  el = bestEl;

  var codeEl = el ? el.querySelector('pre, code') : null;
  return {
    fullText: el ? (el.innerText || '') : '',
    command:  codeEl ? (codeEl.innerText || '') : '',
    skipId:   skipBtn.getAttribute('data-tooltip-id'),
    submitId: submitBtn.getAttribute('data-tooltip-id')
  };
})()
