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

  // Step 3: search for command text in siblings, walking UP to 4 ancestor levels.
  // The command block (e.g. "git push") is a sibling somewhere above the options container.
  var cmdText = '';
  var IGNORE_RE = /^(skip|submit|\u21b5|allow|reject|yes|no)$/i;
  var searchNode = el;
  for (var level = 0; level < 4 && !cmdText; level++) {
    var ancestor = searchNode.parentElement;
    if (!ancestor || ancestor === document.body) break;
    var kids = Array.from(ancestor.children || []);
    for (var k = 0; k < kids.length; k++) {
      var kid = kids[k];
      if (kid === searchNode) continue;          // skip current container
      if (kid.contains(skipBtn)) continue;       // skip footer
      if (kid.contains(submitBtn)) continue;     // skip footer
      var kidText = (kid.innerText || '').trim();
      // Candidate command: non-empty, not a single ignored word, not huge
      if (kidText && kidText.length > 1 && kidText.length < 800 &&
          !IGNORE_RE.test(kidText)) {
        cmdText = kidText;
        break;
      }
    }
    searchNode = ancestor;
  }

  // Also prefer <pre>/<code>/<kbd> anywhere nearby if found
  var nearEl = el.parentElement || el;
  var codeEl = nearEl.querySelector('pre, code, kbd');
  if (codeEl) cmdText = (codeEl.innerText || '').trim();

  return {
    fullText: el ? (el.innerText || '') : '',
    command:  cmdText,
    skipId:   skipBtn.getAttribute('data-tooltip-id'),
    submitId: submitBtn.getAttribute('data-tooltip-id')
  };
})()
