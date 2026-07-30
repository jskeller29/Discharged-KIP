/**
 * Parser assertions. Run from the KIP menu, or from the Apps Script editor.
 * These cover the shapes the old formulas got wrong, so a future edit that
 * reintroduces the cross-line bleed fails here loudly.
 */

function runParserTests() {
  var failures = [];

  function check(name, actual, expected) {
    var a = JSON.stringify(actual);
    var e = JSON.stringify(expected);
    if (a !== e) failures.push(name + '\n  expected ' + e + '\n  actual   ' + a);
  }

  // --- Roster line, no contact ---------------------------------------
  var roster = parseGuardianLine_('*Guardian 1 - Martha Jefferson (Mother)');
  check('roster slot', roster.slot, 1);
  check('roster starred', roster.starred, true);
  check('roster dna', roster.dna, 'No');
  check('roster first', roster.first, 'Martha');
  check('roster last', roster.last, 'Jefferson');
  check('roster relationship', roster.relationship, 'Mother');
  check('roster language default', roster.language, CFG.defaultLanguage);
  check('roster contacts', roster.contacts, []);

  // --- Unstarred means DNA "Yes" -------------------------------------
  check('unstarred dna',
    parseGuardianLine_('Guardian 2 - Thomas Jefferson (Father)').dna, 'Yes');

  // --- Relationship + language ---------------------------------------
  var bilingual = parseGuardianLine_('*Guardian 1 - Ana Ruiz (Mother - Spanish)');
  check('language relationship', bilingual.relationship, 'Mother');
  check('language value', bilingual.language, 'Spanish');

  // --- Contact line ---------------------------------------------------
  var contact = parseGuardianLine_(
    '*Guardian 1 - Martha Jefferson (Mother) - Contact 1: Martha1@gmail.com');
  check('contact name unaffected', contact.first + ' ' + contact.last, 'Martha Jefferson');
  check('contact payload', contact.contacts, [{ index: 1, value: 'Martha1@gmail.com' }]);

  // --- Phone formatting survives --------------------------------------
  check('phone payload',
    parseGuardianLine_(
      '*Guardian 1 - Martha Jefferson (Mother) - Contact 1: (111) 111-1111'
    ).contacts,
    [{ index: 1, value: '(111) 111-1111' }]);

  // --- The regression the old formulas had ----------------------------
  // Guardian 1 has only a Contact 2. The old collapse-newlines-then-".*?"
  // approach walked into Guardian 2's line and returned t@y.com as Martha's
  // Contact 1. Slot-indexed parsing must leave Martha's Contact 1 empty.
  var blob = [
    '*Guardian 1 - Martha Jefferson (Mother) - Contact 2: m@x.com',
    '*Guardian 2 - Thomas Jefferson (Father) - Contact 1: t@y.com'
  ].join('\n');

  var log = new Log();
  var student = { id: '1', guardians: [] };
  var guardians = buildGuardians_(
    student,
    '*Guardian 1 - Martha Jefferson (Mother)\n*Guardian 2 - Thomas Jefferson (Father)',
    blob,
    '',
    log
  );
  check('no bleed: guardian count', guardians.length, 2);
  check('no bleed: Martha email 1 empty', guardians[0].emails[0] || '', '');
  check('no bleed: Martha email 2', guardians[0].emails[1], 'm@x.com');
  check('no bleed: Thomas email 1', guardians[1].emails[0], 't@y.com');

  // --- Two contacts for one slot, on separate lines -------------------
  var twoLine = buildGuardians_(
    { id: '2', guardians: [] },
    '*Guardian 1 - Martha Jefferson (Mother)\n*Guardian 2 - Thomas Jefferson (Father)',
    [
      '*Guardian 1 - Martha Jefferson (Mother) - Contact 1: Martha1@gmail.com',
      '*Guardian 1 - Martha Jefferson (Mother) - Contact 2: Martha2@gmail.com',
      '*Guardian 2 - Thomas Jefferson (Father) - Contact 1: Thomas@aol.com'
    ].join('\n'),
    '*Guardian 1 - Martha Jefferson (Mother) - Contact 1: (111) 111-1111',
    new Log()
  );
  check('two-line: guardian count', twoLine.length, 2);
  check('two-line: Martha emails',
    [twoLine[0].emails[0], twoLine[0].emails[1]],
    ['Martha1@gmail.com', 'Martha2@gmail.com']);
  check('two-line: Thomas emails', twoLine[1].emails[0], 'Thomas@aol.com');
  check('two-line: Martha phone', twoLine[0].phones[0], '(111) 111-1111');
  check('two-line: Thomas no phone', twoLine[1].phones[0] || '', '');

  // --- Regex metacharacters in names no longer matter -----------------
  // The old escaping expression was a no-op, so "(" produced an unbalanced
  // group, REGEXEXTRACT errored, and IFERROR turned it into a silent blank.
  var awkward = buildGuardians_(
    { id: '3', guardians: [] },
    '*Guardian 1 - Robert Smith Jr. (Father)',
    '*Guardian 1 - Robert Smith Jr. (Father) - Contact 1: bob@x.com',
    '',
    new Log()
  );
  check('metachar name preserved', awkward[0].first + ' ' + awkward[0].last,
    'Robert Smith Jr.');
  check('metachar email kept', awkward[0].emails[0], 'bob@x.com');

  // --- Contacts on a slot missing from the roster are kept ------------
  var orphanLog = new Log();
  var orphan = buildGuardians_(
    { id: '4', guardians: [] },
    '*Guardian 1 - Martha Jefferson (Mother)',
    '*Guardian 3 - Sue Kent (Aunt) - Contact 1: sue@x.com',
    '',
    orphanLog
  );
  check('orphan slot kept', orphan.length, 2);
  check('orphan email kept', orphan[1].emails[0], 'sue@x.com');
  check('orphan reported', orphanLog.counts.WARN, 1);

  // --- Normalisers ----------------------------------------------------
  check('phone norm', normPhone_('(111) 111-1111'), '1111111111');
  check('phone norm strips country code', normPhone_('1 (111) 111-1111'), '1111111111');
  check('email norm', normEmail_('  Martha1@GMAIL.com '), 'martha1@gmail.com');
  check('name norm', normName_('  Martha   Jefferson '), 'martha jefferson');

  // --- Blank input ----------------------------------------------------
  check('blank blob', parseBlob_('').lines, []);
  check('null blob', parseBlob_(null).lines, []);
  check('non-guardian line reported', parseBlob_('see office').unparsed, ['see office']);

  // --- The "wait until the row is finished" gate ----------------------
  var rule = CFG.watch.editSheets['Non-Student'];
  var partial  = ['1001', 'Jefferson', '',      '',     '', '', '', '', '', '', '', ''];
  var complete = ['1001', 'Jefferson', 'Patsy', '1001', '', '', '', '', '', '', '', ''];
  var cleared  = ['',     'Jefferson', 'Patsy', '1001', '', '', '', '', '', '', '', ''];

  check('gate: half-typed row is ignored',      rowQualifies_(partial,  rule, 2, 2), false);
  check('gate: completing the row fires',       rowQualifies_(complete, rule, 4, 4), true);
  check('gate: later edit to a done row fires', rowQualifies_(complete, rule, 6, 6), true);
  check('gate: clearing a required cell fires', rowQualifies_(cleared,  rule, 1, 1), true);
  check('gate: broken row stays quiet',         rowQualifies_(cleared,  rule, 6, 6), false);

  var summary = failures.length
    ? failures.length + ' test(s) failed:\n\n' + failures.join('\n\n')
    : 'All parser tests passed.';

  Logger.log(summary);
  try {
    SpreadsheetApp.getUi().alert(summary);
  } catch (e) {
    // Running headless from the editor — the log is enough.
  }
  return failures;
}
