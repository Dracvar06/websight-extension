// Runs as a content script. Answers extraction requests and executes actions
// against the indexed element map built by lib/page-extract.js.
(() => {
  // Roles used by app UIs (Drive, Gmail...) whose items open on
  // double-click or Enter rather than a single click.
  const ITEM_ROLES = ['gridcell', 'row', 'listitem', 'treeitem', 'option'];

  function mouseOpts(el) {
    const rect = el.getBoundingClientRect();
    return {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
    };
  }

  // A believable click: full pointer/mouse sequence at the element's center.
  function syntheticClick(el) {
    const opts = mouseOpts(el);
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(
        type.startsWith('pointer') ? new PointerEvent(type, opts) : new MouseEvent(type, opts)
      );
    }
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keyup']) {
      const ev = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      // Older app code reads keyCode/which, which the constructor cannot set.
      Object.defineProperty(ev, 'keyCode', { get: () => 13 });
      Object.defineProperty(ev, 'which', { get: () => 13 });
      el.dispatchEvent(ev);
    }
  }

  function executeAction(action) {
    if (action.type === 'scroll') {
      const dir = String(action.value || 'down').toLowerCase();
      const doc = document.documentElement;
      if (dir === 'top') window.scrollTo({ top: 0 });
      else if (dir === 'bottom') window.scrollTo({ top: doc.scrollHeight });
      else window.scrollBy({ top: (dir === 'up' ? -0.85 : 0.85) * window.innerHeight });
      const max = Math.max(1, doc.scrollHeight - window.innerHeight);
      const pct = Math.min(100, Math.round((window.scrollY / max) * 100));
      return { ok: true, detail: `Scrolled ${dir}. Now at ${pct} percent of the page.` };
    }
    const ws = window.__websight;
    const el = ws && ws.map ? ws.map[action.index] : undefined;
    if (!el || !el.isConnected) {
      return { ok: false, detail: 'That element is no longer on the page.' };
    }
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || 'element')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);

    el.scrollIntoView({ block: 'center', behavior: 'instant' });

    if (action.type === 'focus') {
      el.focus();
      return { ok: true, detail: `Focused on ${name}.` };
    }
    if (action.type === 'click') {
      el.focus();
      const role = (el.getAttribute('role') || '').toLowerCase();
      syntheticClick(el);
      if (ITEM_ROLES.includes(role)) {
        // Single click usually only selects these; open like a user would.
        el.dispatchEvent(new MouseEvent('dblclick', mouseOpts(el)));
        pressEnter(el);
        return { ok: true, detail: `Opened ${name}.` };
      }
      return { ok: true, detail: `Clicked ${name}.` };
    }
    if (action.type === 'reveal') {
      // Only controls that show more of the page: a dropdown, a tab, a
      // collapsed section. Never a link (that is "explore") and never a
      // button that could submit a form.
      if (el.tagName === 'SELECT') {
        const want = String(action.value || '').toLowerCase().trim();
        const option = Array.from(el.options).find((o) => o.text.toLowerCase().trim() === want) ||
          Array.from(el.options).find((o) => want && o.text.toLowerCase().includes(want));
        if (!option) return { ok: false, detail: `There is no option "${action.value}" in ${name}.` };
        el.value = option.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, detail: `Chose ${option.text.trim()} in ${name}.` };
      }
      if (el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href').startsWith('#')) {
        return { ok: false, detail: 'That is a link to another page, not something that opens here.' };
      }
      // A button sends a form only when it is in one ("type" defaults to
      // submit even for buttons that are not).
      if (el.form && (el.type || '').toLowerCase() === 'submit') {
        return { ok: false, detail: 'That button would send a form, so I did not press it.' };
      }
      el.focus();
      syntheticClick(el);
      return { ok: true, detail: `Opened ${name}.` };
    }
    if (action.type === 'search') {
      // Type into the field, then send it the way a person would: the
      // form's own submit (so its scripts run), or Enter.
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, action.value ?? '');
      else el.value = action.value ?? '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (el.form && el.form.requestSubmit) el.form.requestSubmit();
      else pressEnter(el);
      return { ok: true, detail: `Searched for ${action.value}.` };
    }
    if (action.type === 'fill') {
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, action.value ?? '');
      else el.value = action.value ?? '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: `Filled ${name}.` };
    }
    return { ok: false, detail: `Unknown action type ${action.type}.` };
  }

  // "Show me where": puts the keyboard focus on the element holding the
  // words an answer rests on, so the person's own screen reader reads the
  // real page text: a second witness that does not depend on the AI. Also
  // outlined for a sighted helper. Falls back to the numbers in the answer.
  const squash = (t) => (t || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
  const STOP = new Set('the a an and or of to in on for is are was what when where who how do does i my me you your it this that with at by be can from as'.split(' '));
  const BLOCKS = 'p, li, td, th, dd, dt, h1, h2, h3, h4, h5, h6, blockquote, figcaption, label, a, button, span, strong, em, div, section, article';

  const wordsOf = (t) => new Set(squash(t).match(/[\p{L}\p{N}]+/gu) || []);

  // How well the text around an element (its heading, its card) matches
  // what was asked. The same line can appear more than once: UChicago lists
  // "APPLICATION DEADLINE Jan 4, 2027" under both Early Decision II and
  // Regular Decision, and only the heading tells them apart.
  function fit(el, context) {
    let around = el.parentElement;
    const own = squash(el.innerText).length;
    while (around && around.parentElement && squash(around.innerText).length <= own) around = around.parentElement;
    if (!around) return 0;
    const near = wordsOf(squash(around.innerText).slice(0, 500));
    let hits = 0;
    for (const w of context) if (near.has(w)) hits++;
    return hits;
  }

  function smallestHolding(needle, context) {
    const holding = [];
    for (const el of document.body.querySelectorAll(BLOCKS)) {
      if (!el.offsetParent && el.tagName !== 'BODY') continue; // hidden
      if (squash(el.innerText).includes(needle)) holding.push(el);
    }
    // Keep only the innermost: an element none of whose children also holds it.
    const innermost = holding.filter((el) => !holding.some((other) => other !== el && el.contains(other)));
    let best = null;
    let bestFit = -1;
    for (const el of innermost) {
      const f = fit(el, context);
      if (f > bestFit || (f === bestFit && squash(el.innerText).length < squash(best.innerText).length)) {
        best = el;
        bestFit = f;
      }
    }
    return best;
  }

  function showLine(quote, numbers, about) {
    const context = new Set([...wordsOf(about)].filter((w) => w.length >= 2 && !STOP.has(w)));
    let el = null;
    const q = squash(quote);
    if (q.length >= 4) {
      el = smallestHolding(q, context);
      // Models trim or tweak a quote; try its first and last halves.
      if (!el) {
        const words = q.split(' ');
        if (words.length >= 6) {
          el = smallestHolding(words.slice(0, Math.ceil(words.length / 2)).join(' '), context) ||
            smallestHolding(words.slice(Math.floor(words.length / 2)).join(' '), context);
        }
      }
    }
    for (const n of numbers) {
      if (el) break;
      if (String(n).length >= 2) el = smallestHolding(squash(String(n)), context);
    }
    if (!el) return { ok: false };
    // A short card around the line (its heading plus the line) is read
    // instead, so "Jan 4, 2027" is heard with "Early Decision II".
    let card = el.parentElement;
    while (card && squash(card.innerText).length <= squash(el.innerText).length) card = card.parentElement;
    if (card && card !== document.body && squash(card.innerText).length <= 250) el = card;
    if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus({ preventScroll: true });
    const before = el.style.outline;
    el.style.outline = '4px solid #f5a623';
    setTimeout(() => (el.style.outline = before), 8000);
    return { ok: true, text: el.innerText.replace(/\s+/g, ' ').trim().slice(0, 200) };
  }

  // Exposed for testing outside the extension context.
  (window.__websight = window.__websight || {}).executeAction = executeAction;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg.type === 'websight-extract') {
        sendResponse(window.__websight.extract());
      } else if (msg.type === 'websight-action') {
        sendResponse(executeAction(msg.action));
      } else if (msg.type === 'websight-title') {
        sendResponse({ title: document.title });
      } else if (msg.type === 'websight-show') {
        sendResponse(showLine(msg.quote || '', msg.numbers || [], msg.about || ''));
      } else if (msg.type === 'websight-snapshot') {
        sendResponse(window.__websight.snapshot());
      } else if (msg.type === 'websight-scan-info') {
        sendResponse({
          scrollY: window.scrollY,
          viewportH: window.innerHeight,
          screens: Math.max(1, Math.ceil(document.documentElement.scrollHeight / window.innerHeight)),
        });
      } else if (msg.type === 'websight-scroll-to') {
        window.scrollTo({ top: msg.y, behavior: 'instant' });
        sendResponse({ ok: true });
      }
    } catch (err) {
      sendResponse({ ok: false, detail: String(err && err.message ? err.message : err) });
    }
    return false;
  });
})();
