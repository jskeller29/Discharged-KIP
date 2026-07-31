/**
 * Blob parsing. Pure functions — no SpreadsheetApp calls — so Tests.gs can
 * exercise them directly.
 *
 * The common shape is one line per (guardian slot, contact) pair, so a guardian
 * with two emails occupies two lines, repeating its own name:
 *
 *   *Guardian 1 - Martha Jefferson (Mother) - Contact 1: Martha1@gmail.com
 *   *Guardian 1 - Martha Jefferson (Mother) - Contact 2: Martha2@gmail.com
 *   *Guardian 2 - Thomas Jefferson (Father) - Contact 1: Thomas@aol.com
 *
 * A leading "*" means DNA = "No" (the guardian IS a primary contact).
 * The parenthetical is "Relationship" or "Relationship - Language".
 * The roster blob (column G) uses the same shape with the Contact part absent.
 *
 * Join on the slot number, not the name. Where a slot number is absent the
 * entry's position in the blob is used instead, which keeps the roster, email
 * and phone blobs aligned for records that omit the prefix entirely.
 *
 * Four variants show up in the live data and are all handled here:
 *
 *   1. Unlabeled contact — the value follows " - " with no "Contact N:"
 *        *Guardian 1 - SHELLY BAYNE (Parent) - (917) 312-0601
 *   2. Continuation value — a bare value on its own line, belonging to the
 *      guardian above it
 *        *Guardian 1 - ... - Contact 1: 5165099626
 *        6462763207
 *   3. Wrapped name — one guardian split across lines, sometimes with no
 *      "Guardian N" prefix at all
 *        SUYEON LII
 *        KIM (Parent) - Contact 1: JONATHAN.LII@GMAIL.COM
 *   4. Several values in one slot
 *        Contact 1: JONATHAN.LII@GMAIL.COM SUYEON.K.LII@GMAIL.COM
 *
 * Parsing is kind-aware: the email blob only accepts things containing "@" as
 * loose values, the phone blob only accepts things that look like numbers. That
 * is what keeps genuine junk ("1110", "71- Ariel") in the Build Log instead of
 * being silently absorbed into a name or a contact slot.
 */

var RE_GUARDIAN_HEAD = /^\s*(\*?)\s*Guardian\s*(\d+)\s*-\s*([\s\S]*)$/i;
var RE_CONTACT_START = /Contact\s*\d+\s*:/i;
var RE_CONTACT_ALL   = /Contact\s*(\d+)\s*:\s*([\s\S]*?)(?=\s*-?\s*Contact\s*\d+\s*:|$)/gi;
var RE_ANY_PAREN     = /\(([^)]*)\)/g;
var RE_NUMERIC_ONLY  = /^[\d\s\-.]*$/;
var RE_TRAILING_JUNK = /[\s\-–—]+$/;
var RE_LEADING_JUNK  = /^[\s\-–—:]+/;

var RE_EMAIL_ALL = /[^\s,;<>()]+@[^\s,;<>()]+/g;
var RE_PHONE_ALL = /\(?\d[\d\s().\-]{6,}\d/g;

var KIND_ROSTER = 'roster';
var KIND_EMAIL  = 'email';
var KIND_PHONE  = 'phone';

/** Pasted rosters routinely carry non-breaking / narrow spaces. */
function normSpace_(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/[   ]/g, ' ')
    .trim();
}

/**
 * Every contact value of the expected kind found in a piece of text.
 * Returns [] for the roster blob, which carries no contacts.
 */
function extractValues_(text, kind) {
  var source = String(text || '');

  if (kind === KIND_EMAIL) {
    return source.match(RE_EMAIL_ALL) || [];
  }

  if (kind === KIND_PHONE) {
    var found = source.match(RE_PHONE_ALL) || [];
    var out = [];
    for (var i = 0; i < found.length; i++) {
      var value = found[i].trim();
      // Seven digits is the shortest thing worth calling a phone number; this
      // is what rejects fragments like "1110".
      if (normPhone_(value).length >= 7) out.push(value);
    }
    return out;
  }

  return [];
}

/** True when a line is nothing but contact values and separators. */
function isMostlyValues_(line, values) {
  var rest = line;
  for (var i = 0; i < values.length; i++) {
    rest = rest.replace(values[i], ' ');
  }
  return rest.replace(/[\s,;:\-–—+/]/g, '') === '';
}

/**
 * The first parenthetical that reads as a relationship rather than an area
 * code — so "(Parent)" is found and "(917)" is skipped.
 * @return {?{start: number, end: number, inner: string}}
 */
function findRelationshipParen_(text) {
  RE_ANY_PAREN.lastIndex = 0;
  var m;
  while ((m = RE_ANY_PAREN.exec(text)) !== null) {
    if (!RE_NUMERIC_ONLY.test(m[1])) {
      return { start: m.index, end: m.index + m[0].length, inner: m[1] };
    }
  }
  return null;
}

/**
 * Parse one logical entry — which may have been assembled from several
 * physical lines.
 *
 * @return {?Object} null when the text carries no usable guardian.
 *   { slot, starred, dna, first, last, name, relationship, language,
 *     contacts: [{ index, value }], raw }
 *   `slot` is null when the entry had no "Guardian N" prefix; `index` is null
 *   for a contact whose slot was not stated and should take the next free one.
 */
function parseEntry_(text, kind) {
  var raw = normSpace_(text);
  if (!raw) return null;

  var head = RE_GUARDIAN_HEAD.exec(raw);
  var starred, slot, rest;

  if (head) {
    starred = head[1] === '*';
    slot = Number(head[2]);
    rest = head[3];
  } else {
    starred = /^\*/.test(raw);
    slot = null;
    rest = raw.replace(/^\*\s*/, '');
  }

  // --- labeled contacts -------------------------------------------------
  var contacts = [];
  var namePart = rest;
  var cut = rest.search(RE_CONTACT_START);

  if (cut !== -1) {
    namePart = rest.slice(0, cut).replace(RE_TRAILING_JUNK, '');
    var tail = rest.slice(cut);
    RE_CONTACT_ALL.lastIndex = 0;
    var m;
    while ((m = RE_CONTACT_ALL.exec(tail)) !== null) {
      var label = Number(m[1]);
      var body = m[2].replace(RE_TRAILING_JUNK, '').trim();
      if (!body) continue;

      // One slot can carry several values; the first keeps the stated index
      // and the rest take the next free ones.
      var values = extractValues_(body, kind);
      if (values.length) {
        for (var v = 0; v < values.length; v++) {
          contacts.push({ index: v === 0 ? label : null, value: values[v] });
        }
      } else {
        contacts.push({ index: label, value: body });
      }
      if (RE_CONTACT_ALL.lastIndex === m.index) RE_CONTACT_ALL.lastIndex++;
    }
  }

  // --- relationship, language, and any unlabeled trailing value ---------
  var relationship = '';
  var language = '';
  var trailing = '';
  var paren = findRelationshipParen_(namePart);

  if (paren) {
    trailing = namePart.slice(paren.end);
    var inner = paren.inner;
    var dash = inner.indexOf('-');
    if (dash === -1) {
      relationship = inner.trim();
    } else {
      relationship = inner.slice(0, dash).trim();
      language = inner.slice(dash + 1).trim();
    }
    namePart = namePart.slice(0, paren.start);
  } else {
    // No parenthetical, but the name may still be followed by a bare value.
    var loose = extractValues_(namePart, kind);
    if (loose.length) {
      var at = namePart.indexOf(loose[0]);
      trailing = namePart.slice(at);
      namePart = namePart.slice(0, at);
    }
  }

  var unlabeled = extractValues_(trailing.replace(RE_LEADING_JUNK, ''), kind);
  for (var u = 0; u < unlabeled.length; u++) {
    contacts.push({ index: null, value: unlabeled[u] });
  }

  var name = namePart.replace(RE_TRAILING_JUNK, '').replace(/\s+/g, ' ').trim();

  // An entry with no prefix, no relationship and no contacts is not a
  // guardian — it is stray text, and the caller should report it.
  if (slot === null && !paren && !contacts.length) return null;

  // A nameless guardian IS a guardian: "*Guardian 1 -  (Parent)" states a slot
  // and a relationship, and the matching contact lines carry real values. Only
  // reject when there is nothing usable at all.
  if (!name && !contacts.length && !paren) return null;

  var space = name.indexOf(' ');

  return {
    slot:         slot,
    starred:      starred,
    dna:          starred ? 'No' : 'Yes',
    first:        space === -1 ? name : name.slice(0, space),
    last:         space === -1 ? ''   : name.slice(space + 1),
    name:         name,
    relationship: relationship,
    language:     language || CFG.defaultLanguage,
    contacts:     contacts,
    raw:          raw
  };
}

/**
 * A line that held nothing but contact values, with no guardian named above
 * it. Flagged `positional` so the caller can report how it was attributed.
 */
function valueOnlyEntry_(raw) {
  return {
    slot:         null,
    starred:      false,
    dna:          'Yes',
    first:        '',
    last:         '',
    name:         '',
    relationship: '',
    language:     CFG.defaultLanguage,
    contacts:     [],
    raw:          raw,
    positional:   true
  };
}

/**
 * Parse a whole blob.
 *
 * Physical lines are first assembled into logical entries: a line starting
 * with "Guardian N -" begins one, a line that is nothing but contact values
 * attaches to the entry above it, and anything else is treated as a wrapped
 * continuation — but only while the current entry is still "open", meaning it
 * has not yet picked up a relationship parenthetical. That last condition is
 * what stops junk from being appended to an already-complete guardian.
 *
 * @param {*} blob
 * @param {string} kind  KIND_ROSTER | KIND_EMAIL | KIND_PHONE
 * @return {{ lines: Array<Object>, unparsed: Array<string> }}
 */
function parseBlob_(blob, kind) {
  var out = { lines: [], unparsed: [] };
  if (blob === null || blob === undefined || blob === '') return out;

  kind = kind || KIND_ROSTER;

  var raw = String(blob).split(/\r\n|\r|\n/);
  var entries = [];

  for (var i = 0; i < raw.length; i++) {
    var line = normSpace_(raw[i]);
    if (!line) continue;

    if (RE_GUARDIAN_HEAD.test(line)) {
      entries.push({ text: line, extra: [] });
      continue;
    }

    var values = extractValues_(line, kind);
    if (values.length && isMostlyValues_(line, values)) {
      if (entries.length && entries[entries.length - 1].text !== null) {
        var target = entries[entries.length - 1];
        for (var v = 0; v < values.length; v++) target.extra.push(values[v]);
      } else {
        // A value with no guardian above it. Rather than discard it, hold it
        // as a slotless entry so it falls to the first slot by position and
        // the caller can report how it was attached.
        entries.push({ text: null, raw: line, extra: values.slice() });
      }
      continue;
    }

    var open = entries.length &&
      entries[entries.length - 1].text !== null &&
      !findRelationshipParen_(entries[entries.length - 1].text);

    if (!entries.length) {
      entries.push({ text: line, extra: [] });
    } else if (open) {
      entries[entries.length - 1].text += ' ' + line;
    } else {
      out.unparsed.push(line);
    }
  }

  for (var e = 0; e < entries.length; e++) {
    var entry = entries[e];
    var parsed = entry.text === null
      ? valueOnlyEntry_(entry.raw)
      : parseEntry_(entry.text, kind);

    if (!parsed) {
      out.unparsed.push(entry.text);
      continue;
    }
    for (var x = 0; x < entry.extra.length; x++) {
      parsed.contacts.push({ index: null, value: entry.extra[x] });
    }
    out.lines.push(parsed);
  }

  // Entries with no "Guardian N" prefix fall back to their position, so a
  // record that omits the prefix in all three blobs still lines up.
  var next = 1;
  for (var p = 0; p < out.lines.length; p++) {
    if (out.lines[p].slot === null) {
      out.lines[p].slot = next++;
    } else {
      next = out.lines[p].slot + 1;
    }
  }

  return out;
}

/* ---------------------------------------------------------------------- *
 * Normalisation helpers — used for sibling grouping and de-duplication.
 * ---------------------------------------------------------------------- */

function normEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

/** Digits only; drops a leading US country code so (111) 111-1111 == 11111111111. */
function normPhone_(value) {
  var digits = String(value || '').replace(/\D+/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
  return digits;
}

/** Case- and punctuation-insensitive name key. */
function normName_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
