(function(N) {
  // Find Skip + Submit anchors (same strategy as _dialog_scraper.js)
  var btns = Array.from(document.querySelectorAll('button[data-tooltip-id]'));
  var skipBtn = null, submitBtn = null;
  for (var i = 0; i < btns.length; i++) {
    var t = (btns[i].innerText || btns[i].textContent || '').trim();
    if (!skipBtn   && /^skip$/i.test(t))   skipBtn   = btns[i];
    if (!submitBtn && /^submit/i.test(t)) submitBtn = btns[i];
  }
  if (!skipBtn || !submitBtn) return 'no-dialog';

  // Walk up to common ancestor (dialog container)
  var el = skipBtn.parentElement;
  while (el && el !== document.body) {
    if (el.contains(submitBtn)) break;
    el = el.parentElement;
  }
  if (!el || el === document.body) return 'no-container';

  // Strategy A: all buttons inside container except Skip + Submit, sorted top→bottom
  var optBtns = Array.from(el.querySelectorAll('button'))
    .filter(function(b) { return b !== skipBtn && b !== submitBtn; })
    .sort(function(a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });

  if (optBtns.length > 0) {
    var target = optBtns[N] || optBtns[0];
    target.click();
    return 'clicked-btn-' + N;
  }

  // Strategy B: any focusable element (role=option/radio/button, tabindex) excluding anchors
  var focusable = Array.from(el.querySelectorAll('[role="option"],[role="radio"],[role="button"],[tabindex]'))
    .filter(function(e) { return e !== skipBtn && e !== submitBtn; })
    .sort(function(a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });

  if (focusable.length > 0) {
    var target = focusable[N] || focusable[0];
    target.click();
    return 'clicked-focusable-' + N;
  }

  // Strategy C: keyboard shortcut (1-indexed)
  var key = String(N + 1);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent('keyup',   { key: key, bubbles: true, cancelable: true }));
  return 'keyboard-' + key;
})(OPTION_INDEX)
