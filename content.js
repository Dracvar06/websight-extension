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
