(function() {
  // Shadow-DOM-aware text extraction — skips style/script elements
  function extractText(root) {
    var parts = [];
    var SKIP_TAGS = /^(style|script|noscript|svg)$/i;
    function walk(node) {
      if (!node) return;
      if (node.shadowRoot) walk(node.shadowRoot);
      for (var i = 0; i < node.childNodes.length; i++) {
        var c = node.childNodes[i];
        if (c.nodeType === 3) {                           // text node
          var t = c.textContent.trim();
          if (t) parts.push(t);
        } else if (c.nodeType === 1) {                    // element node
          if (SKIP_TAGS.test(c.tagName || '')) continue; // skip style/script
          if (c.shadowRoot) walk(c.shadowRoot);
          walk(c);
        }
      }
    }
    walk(root);
    return parts.join('\n');
  }

  var btns = Array.from(document.querySelectorAll('button[data-tooltip-id]'));
  var skipBtn = null, submitBtn = null;
  for (var i = 0; i < btns.length; i++) {
    var t = (btns[i].innerText || btns[i].textContent || '').trim();
    if (!skipBtn   && /^skip$/i.test(t))   skipBtn   = btns[i];
    if (!submitBtn && /^submit/i.test(t)) submitBtn = btns[i];
  }
  if (!skipBtn || !submitBtn) return null;

  // Find lowest ancestor containing both Skip + Submit
  var el = skipBtn.parentElement;
  while (el && el !== document.body) {
    if (el.contains(submitBtn)) break;
    el = el.parentElement;
  }
  if (!el || el === document.body) return null;

  // Walk UP conservatively to the full dialog container
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

  var fullText = extractText(el);

  return {
    fullText: fullText,
    command:  '',   // bridge-side contextLines handles value extraction
    skipId:   skipBtn.getAttribute('data-tooltip-id'),
    submitId: submitBtn.getAttribute('data-tooltip-id')
  };
})()
