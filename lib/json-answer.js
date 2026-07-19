// All providers are asked for strict JSON but we parse defensively.
export function parseModelJson(text) {
  const fallback = { answer: (text || '').trim(), lang: '', action: null };
  if (!text) return { answer: 'I did not get a response. Please try again.', lang: 'en', action: null };
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback;
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed.answer !== 'string' || !parsed.answer.trim()) return fallback;
    let action = null;
    if (parsed.action && typeof parsed.action === 'object') {
      const type = String(parsed.action.type || '');
      if (type === 'scroll') {
        action = { type, index: -1, value: String(parsed.action.value || 'down') };
      } else if (['click', 'focus', 'fill'].includes(type) && Number.isInteger(parsed.action.index)) {
        action = { type, index: parsed.action.index, value: parsed.action.value ?? '' };
      }
    }
    return { answer: parsed.answer.trim(), lang: typeof parsed.lang === 'string' ? parsed.lang : '', action };
  } catch {
    return fallback;
  }
}
