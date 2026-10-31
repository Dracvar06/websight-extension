// Numbers are where a wrong answer costs most (a price, a deadline, a
// date) and where a model is most tempted to fill a gap. Every number in an
// answer is looked for in the page text the model was given; the ones that
// are not there are named out loud, so the person knows which part to
// double-check rather than having to doubt the whole answer.

const NUMBER = /\d+(?:[.,:/]\d+)*/g;

function digitsOf(text) {
  return (text.match(NUMBER) || []).map((n) => n.replace(/[.,](?=\d{3}\b)/g, ''));
}

// The numbers in `answer` that appear neither in the page text nor in the
// question. "34.99" matches "€34.99" and "34,99"; "1,500" matches "1500".
export function unverifiedNumbers(answer, pageText, question = '') {
  const known = new Set();
  for (const n of digitsOf(pageText + ' ' + question)) {
    known.add(n);
    known.add(n.replace(',', '.'));
    // "9:00" on the page also confirms "9" in "9 am".
    for (const part of n.split(/[.,:/]/)) known.add(part);
  }
  const missing = [];
  for (const written of answer.match(NUMBER) || []) {
    const n = digitsOf(written)[0];
    if (known.has(n) || known.has(n.replace(',', '.'))) continue;
    // Said back as the answer wrote it ("66,000"), so it matches what they heard.
    if (!missing.includes(written)) missing.push(written);
  }
  return missing;
}

export function numbersNote(missing) {
  if (!missing.length) return '';
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return ` Careful: I could not find ${list} written on the page, so please double-check ${missing.length === 1 ? 'it' : 'them'}.`;
}
