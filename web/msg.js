// What an action did, worded the same way on every page: a sentence with a capital letter and a full
// stop (the server's own messages come in lower case, without one), and one wording for a server that
// can't be reached (also when fetch() itself fails: "Failed to fetch" means nothing to anyone).

export const UNREACHABLE = 'Server unreachable.';

/** `text` as a sentence: capital first letter, " – " for " - ", a full stop at the end. */
export function sentence(text) {
  let s = String(text ?? '').trim().replace(/ - /g, ' – ');
  if (!s) return s;
  s = s[0].toUpperCase() + s.slice(1);
  return /[.!?…]$/.test(s) ? s : s + '.';
}

/** fetch() a JSON API: {ok: false, message} when the server can't be reached or doesn't answer JSON. */
export async function fetchJson(url, opts) {
  let r;
  try {
    r = await fetch(url, opts);
  } catch {
    return { ok: false, message: UNREACHABLE, unreachable: true };
  }
  return r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
}
