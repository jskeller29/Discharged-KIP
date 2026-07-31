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
  var roster = parseEntry_('*Guardian 1 - Martha Jefferson (Mother)', KIND_ROSTER);
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
    parseEntry_('Guardian 2 - Thomas Jefferson (Father)', KIND_ROSTER).dna, 'Yes');

  // --- Relationship + language ---------------------------------------
  var bilingual = parseEntry_('*Guardian 1 - Ana Ruiz (Mother - Spanish)', KIND_ROSTER);
  check('language relationship', bilingual.relationship, 'Mother');
  check('language value', bilingual.language, 'Spanish');

  // --- Contact line ---------------------------------------------------
  var contact = parseEntry_(
    '*Guardian 1 - Martha Jefferson (Mother) - Contact 1: Martha1@gmail.com',
    KIND_EMAIL);
  check('contact name unaffected', contact.first + ' ' + contact.last, 'Martha Jefferson');
  check('contact payload', contact.contacts, [{ index: 1, value: 'Martha1@gmail.com' }]);

  // --- Phone formatting survives --------------------------------------
  check('phone payload',
    parseEntry_(
      '*Guardian 1 - Martha Jefferson (Mother) - Contact 1: (111) 111-1111',
      KIND_PHONE
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

  // --- Variants found in the live data --------------------------------
  // Each of these came out of a Build Log run over the real roster.

  // Unlabeled contact: the value follows " - " with no "Contact N:".
  var unlabeled = buildGuardians_(
    { id: '250080023', guardians: [] },
    '*Guardian 1 - SHELLY BAYNE (Parent)\n*Guardian 2 - GUYTE MCCORD (Parent)',
    '*Guardian 1 - SHELLY BAYNE (Parent)\n' +
      '*Guardian 2 - GUYTE MCCORD (Parent) - gpmcoord@gmail.com',
    '*Guardian 1 - SHELLY BAYNE (Parent) - (917) 312-0601',
    new Log()
  );
  check('unlabeled: name excludes the value', unlabeled[0].name, 'SHELLY BAYNE');
  check('unlabeled: phone captured', unlabeled[0].phones[0], '(917) 312-0601');
  check('unlabeled: email captured', unlabeled[1].emails[0], 'gpmcoord@gmail.com');
  // "(917)" must not be mistaken for the relationship parenthetical.
  check('unlabeled: relationship survives', unlabeled[0].relationship, 'Parent');

  // Wrapped name with no "Guardian N" prefix, plus two emails in one slot
  // and a bare continuation phone.
  var wrapped = buildGuardians_(
    { id: '250086846', guardians: [] },
    'SUYEON LII\nKIM (Parent)',
    'SUYEON LII\nKIM (Parent) - Contact 1: JONATHAN.LII@GMAIL.COM SUYEON.K.LII@GMAIL.COM',
    'SUYEON LII\nKIM (Parent) - Contact 1: 5165099626\n6462763207',
    new Log()
  );
  check('wrapped: one guardian, not three', wrapped.length, 1);
  check('wrapped: name rejoined', wrapped[0].name, 'SUYEON LII KIM');
  check('wrapped: both emails kept',
    [wrapped[0].emails[0], wrapped[0].emails[1]],
    ['JONATHAN.LII@GMAIL.COM', 'SUYEON.K.LII@GMAIL.COM']);
  check('wrapped: continuation phone kept',
    [wrapped[0].phones[0], wrapped[0].phones[1]],
    ['5165099626', '6462763207']);

  // A bare value on its own line belongs to the guardian above it.
  var continued = buildGuardians_(
    { id: '250238891', guardians: [] },
    '*Guardian 1 - Gina Johnson (Mother)',
    '*Guardian 1 - Gina Johnson (Mother) - Contact 1: gjohnson@work.com\n' +
      'ginajohnson995@gmail.com',
    '',
    new Log()
  );
  check('continuation: second email kept', continued[0].emails[1],
    'ginajohnson995@gmail.com');
  check('continuation: name untouched', continued[0].name, 'Gina Johnson');

  // Junk must stay visible rather than being absorbed into a name or a slot.
  var junkLog = new Log();
  var junk = buildGuardians_(
    { id: '257850594', guardians: [] },
    '*Guardian 1 - Real Person (Mother)',
    '*Guardian 1 - Real Person (Mother) - Contact 1: real@x.com\n1110',
    '*Guardian 1 - Real Person (Mother) - Contact 1: (718) 555-1212\n71- Ariel',
    junkLog
  );
  check('junk: name not corrupted', junk[0].name, 'Real Person');
  check('junk: real values kept',
    [junk[0].emails[0], junk[0].phones[0]], ['real@x.com', '(718) 555-1212']);
  check('junk: "1110" not taken as an email', junk[0].emails[1] || '', '');
  check('junk: both fragments reported', junkLog.counts.WARN, 2);

  // Value extraction is kind-aware.
  check('email kind ignores digits', extractValues_('1110', KIND_EMAIL), []);
  check('phone kind rejects short fragments', extractValues_('1110', KIND_PHONE), []);
  check('phone kind rejects "71- Ariel"', extractValues_('71- Ariel', KIND_PHONE), []);
  check('phone kind reads formatted numbers',
    extractValues_('Contact 1: (917) 312-0601', KIND_PHONE), ['(917) 312-0601']);
  check('phone kind reads bare numbers',
    extractValues_('5165099626', KIND_PHONE), ['5165099626']);
  check('area code is not a relationship',
    findRelationshipParen_('SHELLY BAYNE (Parent) - (917) 312-0601').inner, 'Parent');
  check('a purely numeric paren is not a relationship',
    findRelationshipParen_('SHELLY BAYNE - (917) 312-0601'), null);

  // A guardian with a relationship but no name is still a guardian. Rejecting
  // it made the roster line read as unparseable AND its contact line read as
  // an orphan slot — one data problem reported twice, under two wrong names.
  var namelessLog = new Log();
  var nameless = buildGuardians_(
    { id: '5', guardians: [] },
    '*Guardian 1 -   (Parent)',
    '',
    '*Guardian 1 -   (Parent) - Contact 1: (917) 312-0601',
    namelessLog
  );
  check('nameless: kept as a guardian', nameless.length, 1);
  check('nameless: relationship kept', nameless[0].relationship, 'Parent');
  check('nameless: phone kept', nameless[0].phones[0], '(917) 312-0601');
  check('nameless: reported once', namelessLog.rows.length, 1);
  check('nameless: reported accurately', namelessLog.rows[0][LOG_COL.code],
    'NAMELESS_GUARDIAN');

  // A bare value as the very first line of a blob has no guardian above it to
  // attach to. It falls to the first slot by position rather than being lost.
  var leadingLog = new Log();
  var leading = buildGuardians_(
    { id: '6', guardians: [] },
    '*Guardian 1 - Gina Johnson (Mother)',
    'ginajohnson995@gmail.com',
    '',
    leadingLog
  );
  check('leading value: attached to slot 1', leading[0].emails[0],
    'ginajohnson995@gmail.com');
  check('leading value: name comes from the roster', leading[0].name, 'Gina Johnson');
  check('leading value: attribution reported', leadingLog.rows[0][LOG_COL.code],
    'VALUE_WITHOUT_GUARDIAN');

  // --- Anonymisation for the shareable report -------------------------
  check('mask keeps structure, drops identity',
    maskLine_('*Guardian 1 - SHELLY BAYNE (Parent) - (917) 312-0601'),
    '*Guardian 1 - AAAAAA AAAAA (Parent) - (999) 999-9999');
  check('mask keeps the Contact slot number',
    maskLine_('*Guardian 2 - Thomas Jefferson (Father) - Contact 3: t@aol.com'),
    '*Guardian 2 - Aaaaaa Aaaaaaaaa (Father) - Contact 3: a@aaa.aaa');
  check('mask keeps language words',
    maskLine_('Guardian 1 - Ana Ruiz (Mother - Spanish)'),
    'Guardian 1 - Aaa Aaaa (Mother - Spanish)');
  check('mask preserves wrapped-name shape', maskLine_('SUYEON LII'), 'AAAAAA AAA');
  check('mask leaves junk recognisable as junk', maskLine_('71- Ariel'), '99- Aaaaa');

  var anon = new Anonymizer();
  check('refs are sequential', [anon.ref('250080023'), anon.ref('250086846')],
    ['S001', 'S002']);
  check('refs are stable within a report', anon.ref('250080023'), 'S001');
  check('quoted data is masked, prose is not',
    anon.message('Guardian 1 is named "SHELLY BAYNE" in column G.'),
    'Guardian 1 is named "AAAAAA AAAAA" in column G.');
  check('bare OSIS becomes a ref',
    anon.message('grouped into one household (250080023, 250086846)'),
    'grouped into one household (S001, S002)');
  // A masked ten-digit phone must not be mistaken for an OSIS.
  check('masked phone digits stay digits',
    anon.message('moved "5165099626" to position 2'),
    'moved "9999999999" to position 2');

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
