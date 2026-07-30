/**
 * Blob parsing. Pure functions — no SpreadsheetApp calls — so Tests.gs can
 * exercise them directly.
 *
 * The source format is one line per (guardian slot, contact) pair — so a
 * guardian with two emails occupies two lines, repeating its own name:
 *
 *   *Guardian 1 - Martha Jefferson (Mother) - Contact 1: Martha1@gmail.com
 *   *Guardian 1 - Martha Jefferson (Mother) - Contact 2: Martha2@gmail.com
 *   *Guardian 2 - Thomas Jefferson (Father) - Contact 1: Thomas@aol.com
 *
 * A leading "*" means DNA = "No" (the guardian IS a primary contact).
 * The parenthetical is "Relationship" or "Relationship - Language".
 * The roster blob (column G) uses the same shape with the Contact part absent,
 * one line per guardian.
 *
 * Join on the slot number, not the name. The name is expected to repeat
 * identically across a slot's lines; when it does not, that is a data problem
 * worth reporting, but it must never split one slot into two guardians or
 * cause a contact to be dropped.
 */

var RE_GUARDIAN_HEAD = /^\s*(\*?)\s*Guardian\s*(\d+)\s*-\s*([\s\S]*)$/i;
var RE_CONTACT_START = /Contact\s*\d+\s*:/i;
var RE_CONTACT_ALL   = /Contact\s*(\d+)\s*:\s*([\s\S]*?)(?=\s*-?\s*Contact\s*\d+\s*:|$)/gi;
var RE_PARENTHETICAL = /\(([^)]*)\)\s*$/;
var RE_TRAILING_JUNK = /[\s\-–—]+$/;

/**
 * Parse one line.
 * @return {?Object} null when the line is blank or not a Guardian line.
 *   { slot, starred, dna, first, last, name, relationship, language,
 *     contacts: [{ index, value }], raw }
 */
function parseGuardianLine_(line) {
  if (line === null || line === undefined) return null;
  // Pasted rosters routinely carry non-breaking / narrow spaces. Normalise
  // them first so the \s+ splits below behave predictably.
  var text = String(line).replace(/[\u00A0\u2007\u202F]/g, ' ').trim();
  if (!text) return null;

  var head = RE_GUARDIAN_HEAD.exec(text);
  if (!head) return null;

  var starred = head[1] === '*';
  var slot = Number(head[2]);
  var rest = head[3];

  // Split the line into "name + parenthetical" and the trailing contact list.
  var contacts = [];
  var namePart = rest;
  var cut = rest.search(RE_CONTACT_START);
  if (cut !== -1) {
    namePart = rest.slice(0, cut).replace(RE_TRAILING_JUNK, '');
    var tail = rest.slice(cut);
    RE_CONTACT_ALL.lastIndex = 0;
    var m;
    while ((m = RE_CONTACT_ALL.exec(tail)) !== null) {
      var value = m[2].replace(RE_TRAILING_JUNK, '').trim();
      if (value) contacts.push({ index: Number(m[1]), value: value });
      if (RE_CONTACT_ALL.lastIndex === m.index) RE_CONTACT_ALL.lastIndex++;
    }
  }

  // Pull "(Relationship)" or "(Relationship - Language)" off the end.
  var relationship = '';
  var language = '';
  var paren = RE_PARENTHETICAL.exec(namePart);
  if (paren) {
    namePart = namePart.slice(0, paren.index);
    var inner = paren[1];
    var dash = inner.indexOf('-');
    if (dash === -1) {
      relationship = inner.trim();
    } else {
      relationship = inner.slice(0, dash).trim();
      language = inner.slice(dash + 1).trim();
    }
  }

  var name = namePart.replace(/\s+/g, ' ').trim();
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
    raw:          text
  };
}

/**
 * Parse a whole blob into an array of per-line results, skipping blanks and
 * collecting anything that did not look like a Guardian line.
 * @return {{ lines: Array<Object>, unparsed: Array<string> }}
 */
function parseBlob_(blob) {
  var out = { lines: [], unparsed: [] };
  if (blob === null || blob === undefined || blob === '') return out;

  var raw = String(blob).split(/\r\n|\r|\n/);
  for (var i = 0; i < raw.length; i++) {
    var trimmed = raw[i].trim();
    if (!trimmed) continue;
    var parsed = parseGuardianLine_(trimmed);
    if (parsed) out.lines.push(parsed);
    else out.unparsed.push(trimmed);
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
