(function() {
  var btns = Array.from(document.querySelectorAll('button[data-tooltip-id]'));
  var skipBtn = null, submitBtn = null;
  for (var i = 0; i < btns.length; i++) {
    var t = (btns[i].innerText || btns[i].textContent || '').trim();
    if (!skipBtn   && /^skip$/i.test(t))   skipBtn   = btns[i];
    if (!submitBtn && /^submit/i.test(t)) submitBtn = btns[i];
  }
  if (!skipBtn || !submitBtn) return null;

  // Step 1: find lowest ancestor containing both Skip + Submit
  var el = skipBtn.parentElement;
  while (el && el !== document.body) {
    if (el.contains(submitBtn)) break;
    el = el.parentElement;
  }
  if (!el || el === document.body) return null;

  // Step 2: walk UP conservatively — stop at first container with real content
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

  // Step 3: look for command text in SIBLINGS of el only
  // (command block is a sibling of the options container, not inside it)
  var cmdText = '';
  var elParent = el.parentElement;
  if (elParent) {
    var siblings = Array.from(elParent.children || []);
    for (var s = 0; s < siblings.length; s++) {
      var sib = siblings[s];
      if (sib === el) continue;                          // skip options container itself
      if (sib.contains(skipBtn)) continue;               // skip footer
      var sibText = (sib.innerText || '').trim();
      // Command text: non-empty, not a heading/title (checked below), reasonable length
      if (sibText && sibText.length > 0 && sibText.length < 500) {
        cmdText = sibText;
        break;
      }
    }
  }

  // Also check for <pre>/<code>/<kbd> anywhere in el or its parent
  var codeEl = el.querySelector('pre, code, kbd') ||
               (elParent && elParent.querySelector('pre, code, kbd'));
  if (codeEl) cmdText = (codeEl.innerText || '').trim();

  return {
    fullText: el ? (el.innerText || '') : '',
    command:  cmdText,
    skipId:   skipBtn.getAttribute('data-tooltip-id'),
    submitId: submitBtn.getAttribute('data-tooltip-id')
  };
})()
