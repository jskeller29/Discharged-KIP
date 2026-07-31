/**
 * Entry points, the build orchestration, and the Build Log.
 *
 * One read per source range, one write per output block. Nothing calls
 * getRange() or setValue() inside a loop — that is the difference between a
 * two-second build and a two-minute one.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('KIP')
    .addItem('Rebuild now', 'rebuildNow')
    .addItem('Check imports for changes now', 'checkImportsNow')
    .addItem('Watch status', 'showWatchStatus')
    .addSeparator()
    .addItem('Start watching', 'startWatching')
    .addItem('Stop watching', 'stopWatching')
    .addSeparator()
    .addItem('Run parser tests', 'runParserTests')
    .addToUi();
}

/** Menu wrapper — rebuildAll() itself stays UI-free so triggers can call it. */
function rebuildNow() {
  var summary = rebuildAll();
  clearDirty_();
  SpreadsheetApp.getUi().alert(
    'Rebuilt in ' + summary.seconds + 's.\n\n' +
    summary.students + ' students\n' +
    summary.guardians + ' guardians\n' +
    summary.warnings + ' warning(s)' +
    (summary.warnings ? '\n\nSee the "' + CFG.sheets.log + '" tab.' : '')
  );
}

/* ---------------------------------------------------------------------- *
 * Build Log
 * ---------------------------------------------------------------------- */

/**
 * Entries carry a `code` so the shareable report can group them, and a
 * `sample` holding the offending source text verbatim. Keeping the sample out
 * of the message matters: the anonymiser masks samples wholesale and masks
 * only the quoted spans inside messages, so the prose stays readable.
 *
 * Convention: anything in a message that came from the data is double-quoted.
 */
function Log() {
  this.rows = [];
  this.counts = { WARN: 0, INFO: 0 };
}

Log.prototype.add = function (level, code, id, where, message, sample) {
  this.rows.push([
    new Date(), level, code, id, where, message,
    sample === undefined || sample === null ? '' : String(sample)
  ]);
  if (this.counts[level] !== undefined) this.counts[level]++;
};
Log.prototype.warn = function (code, id, where, message, sample) {
  this.add('WARN', code, id, where, message, sample);
};
Log.prototype.info = function (code, id, where, message, sample) {
  this.add('INFO', code, id, where, message, sample);
};

/** Column indices into a log row, for the report writers. */
var LOG_COL = { when: 0, level: 1, code: 2, id: 3, where: 4, message: 5, sample: 6 };

/* ---------------------------------------------------------------------- *
 * Build
 * ---------------------------------------------------------------------- */

function rebuildAll() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Another rebuild is already running.');
  }

  try {
    var started = Date.now();
    var ss = SpreadsheetApp.getActive();
    var log = new Log();

    // ---- Read ---------------------------------------------------------
    var outSheet = mustGetSheet_(ss, CFG.sheets.outputted);
    var lastRow = outSheet.getLastRow();
    var rowCount = lastRow - CFG.outputted.firstDataRow + 1;

    if (rowCount < 1) {
      throw new Error(CFG.sheets.outputted + ' has no data rows. Check that the ' +
        'A2 union formula is still spilling.');
    }

    var rows = outSheet
      .getRange(CFG.outputted.firstDataRow, 1, rowCount, CFG.outputted.readCols)
      .getValues();

    // Trim trailing blanks so the write block matches the real data extent.
    while (rows.length &&
           String(rows[rows.length - 1][CFG.outputted.col.osisD - 1] || '').trim() === '') {
      rows.pop();
    }
    rowCount = rows.length;
    if (!rowCount) throw new Error(CFG.sheets.outputted + ' produced no student rows.');

    // ---- Model --------------------------------------------------------
    var students = buildStudents_(rows, log);
    assignHouseholds_(students, log);

    // ---- Render -------------------------------------------------------
    var parents  = renderParents_(students);
    var tail     = renderOutputtedTail_(students, rowCount);
    var table    = renderTable_(students);
    var contacts = renderContacts_(students);

    // ---- Write --------------------------------------------------------
    writeBlock_(outSheet, CFG.outputted.firstDataRow, CFG.outputted.writeFirstCol,
      tail, CFG.outputted.writeCols);

    writeBlock_(mustGetSheet_(ss, CFG.sheets.parents),
      CFG.parents.firstDataRow, 1, parents, CFG.parents.cols);

    writeBlock_(mustGetSheet_(ss, CFG.sheets.table),
      CFG.table.firstDataRow, 1, table, CFG.table.cols);

    writeBlock_(mustGetSheet_(ss, CFG.sheets.contacts),
      CFG.contacts.firstDataRow, 1, contacts, CFG.contacts.cols);

    var elapsed = ((Date.now() - started) / 1000).toFixed(1);
    var totals = {
      students: students.length,
      guardians: parents.length,
      warnings: log.counts.WARN,
      seconds: Number(elapsed)
    };

    log.info('BUILD_SUMMARY', '', 'Build',
      totals.students + ' students, ' + totals.guardians + ' guardians, ' +
      elapsed + 's.');

    writeLog_(ss, log);
    writeShareableLog_(ss, log, totals);

    return totals;

  } finally {
    lock.releaseLock();
  }
}

/**
 * Overwrite a rectangular block, clearing whatever the previous build left
 * below it. Padding to a fixed width keeps setValues() to a single call.
 */
function writeBlock_(sheet, firstRow, firstCol, values, width) {
  var maxRows = sheet.getMaxRows();
  var available = maxRows - firstRow + 1;

  if (values.length > available) {
    sheet.insertRowsAfter(maxRows, values.length - available);
    maxRows = sheet.getMaxRows();
    available = maxRows - firstRow + 1;
  }

  sheet.getRange(firstRow, firstCol, available, width).clearContent();

  if (!values.length) return;

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (row.length < width) {
      for (var c = row.length; c < width; c++) row[c] = '';
    } else if (row.length > width) {
      values[i] = row.slice(0, width);
    }
  }

  sheet.getRange(firstRow, firstCol, values.length, width).setValues(values);
}

/** The full log, with real data. Stays in the workbook. */
function writeLog_(ss, log) {
  var sheet = ss.getSheetByName(CFG.sheets.log);
  if (!sheet) sheet = ss.insertSheet(CFG.sheets.log);

  sheet.clear();
  sheet.getRange(1, 1, 1, 7)
    .setValues([['When', 'Level', 'Code', 'OSIS', 'Where', 'Message', 'Source line']])
    .setFontWeight('bold');

  if (log.rows.length) {
    sheet.getRange(2, 1, log.rows.length, 7).setValues(log.rows);
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 5);
  sheet.setColumnWidth(6, 480);
  sheet.setColumnWidth(7, 420);
}

/**
 * The shareable log: same findings, no identifying data. Safe to send outside
 * the school. See Anonymize.gs for exactly what is kept and what is masked.
 */
function writeShareableLog_(ss, log, totals) {
  var sheet = ss.getSheetByName(CFG.sheets.shareable);
  if (!sheet) sheet = ss.insertSheet(CFG.sheets.shareable);

  var report = buildShareableReport_(log, totals);
  sheet.clear();

  var block = [];

  block.push(['ANONYMISED BUILD REPORT', '', '', '', '', '']);
  block.push([
    'Names, emails, phone numbers and OSIS have been replaced. Letters become ' +
    'A/a and digits become 9, so the shape of each line is preserved but the ' +
    'content is not. Students are referenced as S001, S002 … which are ' +
    'sequential within this report only.', '', '', '', '', ''
  ]);
  block.push(['Generated', new Date(), '', '', '', '']);
  block.push(['Students', totals.students, 'Guardians', totals.guardians,
    'Build seconds', totals.seconds]);
  block.push(['Students appearing below', report.students, 'Findings',
    report.detail.length, '', '']);
  block.push(['', '', '', '', '', '']);

  block.push(['SUMMARY', '', '', '', '', '']);
  block.push(['Code', 'Level', 'Count', '', '', '']);
  if (report.summary.length) {
    for (var s = 0; s < report.summary.length; s++) {
      block.push([report.summary[s][0], report.summary[s][1], report.summary[s][2],
        '', '', '']);
    }
  } else {
    block.push(['(nothing to report)', '', '', '', '', '']);
  }

  block.push(['', '', '', '', '', '']);
  block.push(['DETAIL', '', '', '', '', '']);
  block.push(['Ref', 'Level', 'Code', 'Where', 'Message', 'Source line (masked)']);

  var headerRows = [1, 7, 8, block.length];   // 1-based rows to embolden
  var detailHeaderRow = block.length;

  for (var d = 0; d < report.detail.length; d++) block.push(report.detail[d]);

  sheet.getRange(1, 1, block.length, 6).setValues(block);

  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(12);
  sheet.getRange(2, 1).setFontStyle('italic').setWrap(true);
  sheet.setRowHeight(2, 56);
  sheet.getRange(2, 1, 1, 6).merge();
  for (var h = 0; h < headerRows.length; h++) {
    sheet.getRange(headerRows[h], 1, 1, 6).setFontWeight('bold');
  }
  sheet.setFrozenRows(detailHeaderRow);

  sheet.setColumnWidth(1, 70);
  sheet.setColumnWidth(2, 60);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 150);
  sheet.setColumnWidth(5, 420);
  sheet.setColumnWidth(6, 420);
}

function mustGetSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: "' + name + '"');
  return sheet;
}

/* Trigger installation and change detection live in Triggers.gs. */
