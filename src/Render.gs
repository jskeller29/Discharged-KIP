/**
 * Renders the model into the four script-owned output blocks. Each function
 * returns a plain 2-D array; Main.gs does the single setValues() write.
 */

/** Parents Divided3 A:N — one row per guardian. */
function renderParents_(students) {
  var out = [];

  for (var i = 0; i < students.length; i++) {
    var s = students[i];
    for (var g = 0; g < s.guardians.length; g++) {
      var gd = s.guardians[g];
      var row = new Array(CFG.parents.cols);

      row[0]  = s.id;            // A student_id
      row[1]  = gd.raw;          // B Guardian output (verbatim source line)
      row[2]  = gd.first;        // C First Name
      row[3]  = gd.last;         // D last_name
      row[4]  = gd.relationship; // E relationship
      row[5]  = gd.language;     // F language
      row[6]  = gd.dna;          // G DNA

      for (var e = 0; e < CFG.parents.maxEmails; e++) {
        row[7 + e] = gd.emails[e] || '';      // H, I, J
      }
      for (var p = 0; p < CFG.parents.maxPhones; p++) {
        row[10 + p] = gd.phones[p] || '';     // K, L, M, N
      }

      out.push(row);
    }
  }

  return out;
}

/**
 * OUTPUTTED SHEET K:P.
 *   K parent names, L emails, M phones, N siblings, O primary names, P student
 * Row order matches the A:J block exactly, so the write is positional.
 */
function renderOutputtedTail_(students, rowCount) {
  var out = [];
  for (var i = 0; i < rowCount; i++) {
    out.push(['', '', '', '', '', '']);
  }

  for (var s = 0; s < students.length; s++) {
    var student = students[s];
    var offset = student.row - CFG.outputted.firstDataRow;
    if (offset < 0 || offset >= rowCount) continue;

    var names = [];
    var primary = [];
    for (var g = 0; g < student.guardians.length; g++) {
      var gd = student.guardians[g];
      if (!gd.name) continue;
      names.push(gd.name);
      // DNA "No" (a leading "*") marks the guardian as a primary contact.
      if (gd.dna.toLowerCase() === 'no') {
        primary.push(gd.relationship ? gd.name + ' (' + gd.relationship + ')' : gd.name);
      }
    }

    var siblings = siblingsOf_(student);
    var siblingText = '';
    if (siblings.length) {
      var parts = [];
      for (var k = 0; k < siblings.length; k++) {
        var sib = siblings[k];
        parts.push((sib.firstName + ' ' + sib.lastName).replace(/\s+/g, ' ').trim() +
          ' (' + sib.id + ')');
      }
      siblingText = 'Siblings: ' + parts.join(', ');
    }

    out[offset] = [
      names.join(' and '),
      allEmails_(student).join('\n'),
      allPhones_(student).join('\n'),
      siblingText,
      primary.join(' and '),
      (student.firstName + ' ' + student.lastName).replace(/\s+/g, ' ').trim()
    ];
  }

  return out;
}

/**
 * Table A5:G — one row per student.
 * A OSIS | B Student | C Guardian (= primary names) | D Site | E Class | F Label
 * G      | the delimited guardian sub-table consumed by the front end
 */
function renderTable_(students) {
  var out = [];

  for (var i = 0; i < students.length; i++) {
    var s = students[i];

    var primary = [];
    for (var g = 0; g < s.guardians.length; g++) {
      var gd = s.guardians[g];
      if (!gd.name) continue;
      if (gd.dna.toLowerCase() === 'no') {
        primary.push(gd.relationship ? gd.name + ' (' + gd.relationship + ')' : gd.name);
      }
    }

    out.push([
      s.id,
      (s.firstName + ' ' + s.lastName).replace(/\s+/g, ' ').trim(),
      primary.join(' and '),
      s.site,
      s.classRoom,
      s.label,
      renderGuardianGrid_(s)
    ]);
  }

  return out;
}

/**
 * The Table!G payload: a header row plus one row per guardian, joined with the
 * same sentinels the previous MAP formula produced.
 */
function renderGuardianGrid_(student) {
  if (!student.guardians.length) return '';

  var rows = [['Name', 'Relationship', 'Language', 'Email', 'Phone', 'Primary']];

  for (var i = 0; i < student.guardians.length; i++) {
    var gd = student.guardians[i];
    rows.push([
      gd.name,
      gd.relationship,
      gd.language,
      uniqueNonBlank_(gd.emails).join('\n'),
      uniqueNonBlank_(gd.phones).join('\n'),
      // Primary is the inverse of DNA, matching the previous formula.
      gd.dna.toLowerCase() === 'yes' ? 'No' : 'Yes'
    ]);
  }

  var lines = [];
  for (var r = 0; r < rows.length; r++) {
    lines.push(rows[r].join(CFG.table.colDelim));
  }
  return lines.join(CFG.table.rowDelim);
}

/**
 * Phone Contacts A:AU — Google Contacts CSV layout, one row per guardian.
 * Row order matches Parents Divided3.
 */
function renderContacts_(students) {
  var C = CFG.contacts.col;
  var out = [];

  for (var i = 0; i < students.length; i++) {
    var s = students[i];
    var studentName = (s.firstName + ' ' + s.lastName).replace(/\s+/g, ' ').trim();

    for (var g = 0; g < s.guardians.length; g++) {
      var gd = s.guardians[g];
      var row = new Array(CFG.contacts.cols);
      for (var c = 0; c < CFG.contacts.cols; c++) row[c] = '';

      row[C.osis - 1] = s.id;

      // "<Label> (Relationship) First Last", with the label omitted for MASTER.
      // Trimmed because rows sourced from PASTE SHEET!N:W carry no label.
      var prefix = (s.label && s.label.toUpperCase() !== 'MASTER') ? s.label : '';
      var rel = gd.relationship ? '(' + gd.relationship + ')' : '';
      row[C.firstName - 1] = [prefix, rel, gd.name].join(' ').replace(/\s+/g, ' ').trim();

      row[C.lastName - 1] = studentName ? 'Student: ' + studentName : '';

      var emails = uniqueNonBlank_(gd.emails);
      var emailCols = [
        [C.email1Lbl, C.email1Val],
        [C.email2Lbl, C.email2Val],
        [C.email3Lbl, C.email3Val]
      ];
      for (var e = 0; e < emailCols.length; e++) {
        if (!emails[e]) continue;
        row[emailCols[e][0] - 1] = gd.name;
        row[emailCols[e][1] - 1] = emails[e];
      }

      var phones = uniqueNonBlank_(gd.phones);
      var phoneCols = [
        [C.phone1Lbl, C.phone1Val],
        [C.phone2Lbl, C.phone2Val],
        [C.phone3Lbl, C.phone3Val],
        [C.phone4Lbl, C.phone4Val]
      ];
      for (var p = 0; p < phoneCols.length; p++) {
        if (!phones[p]) continue;
        row[phoneCols[p][0] - 1] = gd.name;
        row[phoneCols[p][1] - 1] = phones[p];
      }

      row[C.labels - 1] = s.label;

      out.push(row);
    }
  }

  return out;
}
