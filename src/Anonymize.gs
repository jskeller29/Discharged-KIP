/**
 * Structural anonymisation for the shareable report.
 *
 * The goal is a file that can be handed to someone outside the school without
 * carrying a single real name, address, phone number or OSIS — while still
 * showing exactly what shape the offending data had, because that shape is the
 * whole diagnostic.
 *
 *   *Guardian 1 - SHELLY BAYNE (Parent) - (917) 312-0601
 *   *Guardian 1 - AAAAAA AAAAA (Parent) - (999) 999-9999
 *
 * What survives, deliberately:
 *   • structure — punctuation, spacing, dashes, asterisks, parentheses
 *   • the words "Guardian" and "Contact" and their slot numbers
 *   • relationship and language words, which are categories rather than PII
 *   • letter case and token lengths, so a wrapped name still looks wrapped
 *
 * What does not:
 *   • every other letter → A / a
 *   • every other digit → 9
 *   • OSIS numbers → a per-report reference (S001, S002 …)
 *
 * The reference map is sequential and lives only for the duration of one
 * report, so entries about the same student can be correlated with each other
 * and with nothing else.
 */

/** Category words worth keeping — they carry no identity and a lot of signal. */
var KEEP_WORDS = {};
(function () {
  var words = [
    // structural
    'guardian', 'contact',
    // relationships
    'mother', 'father', 'parent', 'parents', 'guardian', 'stepmother',
    'stepfather', 'stepparent', 'grandmother', 'grandfather', 'grandparent',
    'aunt', 'uncle', 'sister', 'brother', 'sibling', 'cousin', 'foster',
    'adoptive', 'legal', 'self', 'other', 'relative', 'friend', 'neighbor',
    // languages seen in NYC DOE records
    'english', 'spanish', 'chinese', 'mandarin', 'cantonese', 'bengali',
    'arabic', 'russian', 'french', 'haitian', 'creole', 'urdu', 'korean',
    'japanese', 'hebrew', 'yiddish', 'polish', 'italian', 'portuguese',
    'albanian', 'punjabi', 'hindi', 'vietnamese', 'tagalog', 'greek',
    'german', 'turkish', 'fulani', 'wolof', 'twi', 'uzbek', 'tajik', 'nepali'
  ];
  for (var i = 0; i < words.length; i++) KEEP_WORDS[words[i]] = true;
})();

// "Guardian 3" and "Contact 2" are matched first so their numbers survive.
var RE_MASK_SCAN = /(Guardian\s*\d+|Contact\s*\d+|[A-Za-z]+|\d+)/g;

/** A message splits into quoted segments (data) and unquoted ones (prose). */
var RE_SEGMENTS = /"([^"]*)"|([^"]+)/g;
var RE_BARE_OSIS = /\b\d{6,}\b/g;

/**
 * Shape-preserving mask for a raw piece of source text.
 * Every character that is not a letter or a digit passes through untouched.
 */
function maskLine_(text) {
  if (text === null || text === undefined) return '';

  return String(text).replace(RE_MASK_SCAN, function (token) {
    if (/^Guardian\s*\d+$/i.test(token)) return token;
    if (/^Contact\s*\d+$/i.test(token)) return token;
    if (/^\d+$/.test(token)) return token.replace(/\d/g, '9');
    if (KEEP_WORDS[token.toLowerCase()]) return token;
    return token.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a');
  });
}

function Anonymizer() {
  this.refs = {};
  this.next = 1;
}

/** Stable within one report, meaningless outside it. */
Anonymizer.prototype.ref = function (id) {
  var key = String(id === null || id === undefined ? '' : id).trim();
  if (!key) return '';
  if (!this.refs[key]) {
    var n = String(this.next++);
    while (n.length < 3) n = '0' + n;
    this.refs[key] = 'S' + n;
  }
  return this.refs[key];
};

/**
 * Mask a log message: quoted spans hold data and are masked, the prose around
 * them is structure and is kept. Any OSIS appearing bare in the text is
 * swapped for its reference.
 */
Anonymizer.prototype.message = function (text) {
  var self = this;
  var out = String(text === null || text === undefined ? '' : text);

  // Walk the message in alternating quoted / unquoted segments. Quoted spans
  // are data and get masked. Unquoted long digit runs are OSIS — the household
  // message lists them comma-separated — and get a reference.
  //
  // Doing this in one pass matters: a masked phone such as "5165099626" is ten
  // digits, and a second pass over the whole string would turn it into a
  // student reference.
  return out.replace(RE_SEGMENTS, function (whole, quoted, plain) {
    if (quoted !== undefined) return '"' + maskLine_(quoted) + '"';
    return plain.replace(RE_BARE_OSIS, function (m) { return self.ref(m); });
  });
};

Anonymizer.prototype.sample = function (text) {
  return maskLine_(text);
};

/**
 * Build the shareable report body from a Log.
 * @return {{ summary: Array<Array>, detail: Array<Array> }}
 */
function buildShareableReport_(log, totals) {
  var anon = new Anonymizer();

  // Reference every student mentioned, in first-seen order, before masking —
  // so the household message can resolve the ids it lists.
  for (var i = 0; i < log.rows.length; i++) {
    var id = log.rows[i][LOG_COL.id];
    if (id) anon.ref(id);
  }

  var byCode = {};
  var order = [];
  var detail = [];

  for (var r = 0; r < log.rows.length; r++) {
    var row = log.rows[r];
    var code = row[LOG_COL.code] || 'UNCODED';

    if (!byCode[code]) {
      byCode[code] = { count: 0, level: row[LOG_COL.level] };
      order.push(code);
    }
    byCode[code].count++;

    if (code === 'BUILD_SUMMARY') continue;

    detail.push([
      anon.ref(row[LOG_COL.id]),
      row[LOG_COL.level],
      code,
      row[LOG_COL.where],
      anon.message(row[LOG_COL.message]),
      anon.sample(row[LOG_COL.sample])
    ]);
  }

  var summary = [];
  for (var k = 0; k < order.length; k++) {
    if (order[k] === 'BUILD_SUMMARY') continue;
    summary.push([order[k], byCode[order[k]].level, byCode[order[k]].count]);
  }
  summary.sort(function (a, b) { return b[2] - a[2]; });

  return {
    summary: summary,
    detail: detail,
    totals: totals,
    students: anon.next - 1
  };
}
