/**
 * Builds the in-memory model from OUTPUTTED SHEET A:J, then derives households.
 * Everything downstream (Parents Divided3, K:P, Table, Phone Contacts) renders
 * from this model, so the blobs are parsed exactly once per build.
 */

/**
 * @param {Array<Array>} rows  OUTPUTTED SHEET A:J values, data rows only.
 * @param {Log} log
 * @return {Array<Object>} students
 */
function buildStudents_(rows, log) {
  var C = CFG.outputted.col;
  var students = [];
  var seen = {};

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var id = String(row[C.osisD - 1] || '').trim();
    if (!id) continue;

    var sheetRow = CFG.outputted.firstDataRow + r;

    if (seen[id]) {
      log.warn(id, CFG.sheets.outputted,
        'Duplicate OSIS — also on row ' + seen[id] + '. Both rows kept; guardian ' +
        'lookups elsewhere resolve to the first.');
    } else {
      seen[id] = sheetRow;
    }

    var student = {
      id:        id,
      row:       sheetRow,
      lastName:  String(row[C.lastName - 1] || '').trim(),
      firstName: String(row[C.firstName - 1] || '').trim(),
      site:      row[C.site - 1],
      classRoom: row[C.classRoom - 1],
      label:     String(row[C.label - 1] || '').trim(),
      guardians: []
    };

    student.guardians = buildGuardians_(
      student,
      row[C.parentName - 1],
      row[C.email - 1],
      row[C.cell - 1],
      log
    );

    students.push(student);
  }

  return students;
}

/**
 * Merge the three blobs for one student into an ordered guardian list.
 *
 * Slot number is the join key. The roster blob (column G) supplies identity;
 * the email and phone blobs supply contacts and may carry a *different* name
 * for the same slot, which is recorded as a variant rather than acted on.
 */
function buildGuardians_(student, rosterBlob, emailBlob, phoneBlob, log) {
  var id = student.id;

  var roster = parseBlob_(rosterBlob);
  var emails = parseBlob_(emailBlob);
  var phones = parseBlob_(phoneBlob);

  reportUnparsed_(log, id, 'G (Parent Name)', roster.unparsed);
  reportUnparsed_(log, id, 'H (Email Address)', emails.unparsed);
  reportUnparsed_(log, id, 'I (Parent Cell)', phones.unparsed);

  var bySlot = {};
  var order = [];

  function slotFor(line) {
    var key = String(line.slot);
    if (!bySlot[key]) {
      bySlot[key] = {
        slot:         line.slot,
        first:        line.first,
        last:         line.last,
        relationship: line.relationship,
        language:     line.language,
        dna:          line.dna,
        raw:          line.raw,
        emails:       [],
        phones:       [],
        variants:     {},
        fromRoster:   false
      };
      order.push(key);
    }
    return bySlot[key];
  }

  // Identity comes from the roster blob.
  for (var i = 0; i < roster.lines.length; i++) {
    var rl = roster.lines[i];
    var g = slotFor(rl);
    if (g.fromRoster) {
      log.warn(id, 'G (Parent Name)',
        'Guardian ' + rl.slot + ' listed more than once in the roster. Kept "' +
        g.first + ' ' + g.last + '", ignored "' + rl.name + '".');
      continue;
    }
    g.first = rl.first;
    g.last = rl.last;
    g.relationship = rl.relationship;
    g.language = rl.language;
    g.dna = rl.dna;
    g.raw = rl.raw;
    g.fromRoster = true;
  }

  // Contacts are placed by their own slot index, never by name.
  applyContacts_(log, id, 'H (Email Address)', emails.lines, slotFor,
    'emails', CFG.parents.maxEmails);
  applyContacts_(log, id, 'I (Parent Cell)', phones.lines, slotFor,
    'phones', CFG.parents.maxPhones);

  var out = [];
  for (var k = 0; k < order.length; k++) {
    var guardian = bySlot[order[k]];

    if (!guardian.fromRoster) {
      log.warn(id, CFG.sheets.outputted,
        'Guardian ' + guardian.slot + ' has contacts but no entry in column G. ' +
        'Kept using the name found alongside the contact ("' +
        guardian.first + ' ' + guardian.last + '").');
    }

    var variants = Object.keys(guardian.variants);
    if (variants.length) {
      log.info(id, CFG.sheets.outputted,
        'Guardian ' + guardian.slot + ' is named "' + guardian.first + ' ' +
        guardian.last + '" in column G but ' + variants.join(' / ') +
        ' alongside its contacts. Contacts were kept on slot ' + guardian.slot + '.');
    }

    guardian.name = (guardian.first + ' ' + guardian.last).replace(/\s+/g, ' ').trim();
    out.push(guardian);
  }

  out.sort(function (a, b) { return a.slot - b.slot; });
  return out;
}

/** Place every contact on its slot, at its own contact index. */
function applyContacts_(log, id, where, lines, slotFor, bucket, capacity) {
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var g = slotFor(line);

    var lineName = (line.first + ' ' + line.last).replace(/\s+/g, ' ').trim();
    var known = (g.first + ' ' + g.last).replace(/\s+/g, ' ').trim();
    if (lineName && known && normName_(lineName) !== normName_(known)) {
      g.variants['"' + lineName + '"'] = true;
    }

    for (var c = 0; c < line.contacts.length; c++) {
      var contact = line.contacts[c];
      var slotIndex = contact.index;

      if (slotIndex < 1 || slotIndex > capacity) {
        log.warn(id, where,
          'Guardian ' + line.slot + ' Contact ' + slotIndex + ' ("' + contact.value +
          '") is outside the ' + capacity + ' available columns and was dropped.');
        continue;
      }

      var existing = g[bucket][slotIndex - 1];
      if (existing && existing !== contact.value) {
        log.warn(id, where,
          'Guardian ' + line.slot + ' has two different values for Contact ' +
          slotIndex + ': kept "' + existing + '", dropped "' + contact.value + '".');
        continue;
      }
      g[bucket][slotIndex - 1] = contact.value;
    }
  }
}

function reportUnparsed_(log, id, where, unparsed) {
  for (var i = 0; i < unparsed.length; i++) {
    log.warn(id, where, 'Could not parse line: ' + unparsed[i]);
  }
}

/* ---------------------------------------------------------------------- *
 * Households (siblings)
 *
 * Replaces COUNTIF over the joined guardian-name text, which broke on
 * ordering, case, whitespace, and the 255-character criterion limit.
 *
 * Two students share a household when they share a normalised guardian
 * email or phone, or when their normalised guardian name sets are equal.
 * Union-find keeps that transitive.
 * ---------------------------------------------------------------------- */

function assignHouseholds_(students, log) {
  var parent = {};

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    var ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  function ensure(x) {
    if (parent[x] === undefined) parent[x] = x;
  }

  var byKey = {};

  for (var i = 0; i < students.length; i++) {
    var s = students[i];
    var node = 'S:' + i;
    ensure(node);

    var keys = [];
    var names = [];

    for (var g = 0; g < s.guardians.length; g++) {
      var guardian = s.guardians[g];

      for (var e = 0; e < guardian.emails.length; e++) {
        var email = normEmail_(guardian.emails[e]);
        if (email) keys.push('E:' + email);
      }
      for (var p = 0; p < guardian.phones.length; p++) {
        var phone = normPhone_(guardian.phones[p]);
        if (phone) keys.push('P:' + phone);
      }
      var name = normName_(guardian.name);
      if (name) names.push(name);
    }

    if (names.length) {
      names.sort();
      keys.push('N:' + names.join('|'));
    }

    for (var k = 0; k < keys.length; k++) {
      ensure(keys[k]);
      union(node, keys[k]);
      byKey[keys[k]] = true;
    }
  }

  // Collect members per root.
  var groups = {};
  for (var j = 0; j < students.length; j++) {
    var root = find('S:' + j);
    if (!groups[root]) groups[root] = [];
    groups[root].push(students[j]);
  }

  for (var r in groups) {
    if (!Object.prototype.hasOwnProperty.call(groups, r)) continue;
    var members = groups[r];
    for (var m = 0; m < members.length; m++) {
      members[m].household = members;
    }
    if (members.length >= CFG.limits.suspiciousHouseholdSize) {
      var ids = [];
      for (var n = 0; n < members.length; n++) ids.push(members[n].id);
      log.info(ids[0], 'Siblings',
        members.length + ' students were grouped into one household (' +
        ids.join(', ') + '). Worth checking for a shared office number or a ' +
        'placeholder email.');
    }
  }

  return students;
}

/** Siblings of a student, in roster order, excluding the student. */
function siblingsOf_(student) {
  var household = student.household || [student];
  var out = [];
  for (var i = 0; i < household.length; i++) {
    if (household[i] !== student) out.push(household[i]);
  }
  return out;
}

/** Ordered unique non-blank values. */
function uniqueNonBlank_(values) {
  var seen = {};
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (v === null || v === undefined) continue;
    v = String(v).trim();
    if (!v || seen[v]) continue;
    seen[v] = true;
    out.push(v);
  }
  return out;
}

function allEmails_(student) {
  var out = [];
  for (var i = 0; i < student.guardians.length; i++) {
    out = out.concat(student.guardians[i].emails);
  }
  return uniqueNonBlank_(out);
}

function allPhones_(student) {
  var out = [];
  for (var i = 0; i < student.guardians.length; i++) {
    out = out.concat(student.guardians[i].phones);
  }
  return uniqueNonBlank_(out);
}
