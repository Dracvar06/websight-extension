// Runs as a content script. Builds a structured text description of the page
// plus an indexed map of interactive elements that content.js uses to act on.
(() => {
  const ws = (window.__websight = window.__websight || {});

  function isVisible(el) {
    if (!el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map((l) => l.textContent.trim()).join(' ').trim();
      if (t) return t;
    }
    if (el.placeholder) return el.placeholder.trim();
    if (el.alt) return el.alt.trim();
    if (el.title) return el.title.trim();
    if (el.value && (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button'))) return el.value.trim();
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 80);
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.href) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'dropdown';
    if (tag === 'textarea') return 'text field';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio button';
      return type + ' field';
    }
    return tag;
  }

  // ARIA roles that app UIs (Drive, Gmail, Notion...) use for openable items.
  const ITEM_ROLES = ['gridcell', 'row', 'listitem', 'treeitem', 'option'];

  function friendlyRole(el) {
    const role = roleOf(el);
    return ITEM_ROLES.includes(role) ? 'item' : role;
  }

  function headingsOutline() {
    const lines = [];
    document.querySelectorAll('h1, h2, h3').forEach((h) => {
      if (!isVisible(h)) return;
      const text = h.innerText.replace(/\s+/g, ' ').trim();
      if (text) lines.push(`${h.tagName}: ${text}`);
    });
    return lines.slice(0, 40);
  }

  function landmarks() {
    const found = [];
    const selectors = {
      navigation: 'nav, [role="navigation"]',
      'main content': 'main, [role="main"]',
      search: '[role="search"]',
      header: 'header, [role="banner"]',
      footer: 'footer, [role="contentinfo"]',
      form: 'form',
    };
    for (const [name, sel] of Object.entries(selectors)) {
      const count = Array.from(document.querySelectorAll(sel)).filter(isVisible).length;
      if (count) found.push(count > 1 ? `${name} (${count})` : name);
    }
    return found;
  }

  function mainText() {
    const root =
      document.querySelector('main, [role="main"], article') || document.body;
    if (!root) return '';
    return (root.innerText || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 6000);
  }

  ws.extract = function extract() {
    const map = (ws.map = []);
    const elements = [];
    const seen = new Set();
    const candidates = document.querySelectorAll(
      'a[href], button, input, select, textarea, [role="button"], [role="link"], ' +
        '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], ' +
        '[role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], ' +
        '[role="gridcell"], [role="row"], [role="listitem"], [role="treeitem"], [role="option"], [onclick]'
    );
    for (const el of candidates) {
      if (map.length >= 120) break;
      if (seen.has(el) || !isVisible(el)) continue;
      seen.add(el);
      // Nested matches (a row and the buttons inside it) collapse to the
      // outermost element, which is the one the user means.
      if (map.some((m) => m.contains(el))) continue;
      const name = accessibleName(el);
      if (!name && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue;
      const index = map.length;
      map.push(el);
      elements.push({ index, role: friendlyRole(el), name: name || '(unlabeled)' });
    }

    const sections = [
      `TITLE: ${document.title}`,
      `URL: ${location.href}`,
      `LANDMARKS: ${landmarks().join(', ') || 'none detected'}`,
      `HEADINGS:\n${headingsOutline().join('\n') || '(none)'}`,
      `INTERACTIVE ELEMENTS (use these indexes for actions):\n${elements
        .map((e) => `[${e.index}] ${e.role}: ${e.name}`)
        .join('\n') || '(none)'}`,
      `PAGE TEXT:\n${mainText()}`,
    ];

    return { pageText: sections.join('\n\n'), elements };
  };
})();
