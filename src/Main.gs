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

function Log() {
  this.rows = [];
  this.counts = { WARN: 0, INFO: 0 };
}

Log.prototype.add = function (level, id, where, message) {
  this.rows.push([new Date(), level, id, where, message]);
  if (this.counts[level] !== undefined) this.counts[level]++;
};
Log.prototype.warn = function (id, where, message) { this.add('WARN', id, where, message); };
Log.prototype.info = function (id, where, message) { this.add('INFO', id, where, message); };

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
    log.info('', 'Build',
      students.length + ' students, ' + parents.length + ' guardians, ' +
      elapsed + 's.');

    writeLog_(ss, log);

    return {
      students: students.length,
      guardians: parents.length,
      warnings: log.counts.WARN,
      seconds: Number(elapsed)
    };

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

function writeLog_(ss, log) {
  var sheet = ss.getSheetByName(CFG.sheets.log);
  if (!sheet) {
    sheet = ss.insertSheet(CFG.sheets.log);
  }
  sheet.clear();
  sheet.getRange(1, 1, 1, 5)
    .setValues([['When', 'Level', 'OSIS', 'Where', 'Message']])
    .setFontWeight('bold');

  if (log.rows.length) {
    sheet.getRange(2, 1, log.rows.length, 5).setValues(log.rows);
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 4);
}

function mustGetSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: "' + name + '"');
  return sheet;
}

/* Trigger installation and change detection live in Triggers.gs. */
