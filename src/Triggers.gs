/**
 * Change detection.
 *
 * Nothing here rebuilds directly. Edits and polls set a "dirty" flag, and
 * tick() is the only thing that calls rebuildAll(). That debouncing matters:
 * pasting fifty rows fires onEdit fifty times, and without the flag that
 * would be fifty rebuilds.
 *
 *   onEditHandler   installable, this workbook only
 *   onChangeHandler installable, catches row inserts/deletes that onEdit misses
 *   tick            time-driven; drains the flag, and periodically polls the
 *                   IMPORTRANGE-fed ranges for changes made in other files
 */

var PROP_DIRTY     = 'kip.dirty';
var PROP_LAST_POLL = 'kip.lastPoll';
var PROP_LAST_BUILD = 'kip.lastBuild';
var PROP_HASH      = 'kip.hash.';

function props_() {
  return PropertiesService.getDocumentProperties();
}

/* ---------------------------------------------------------------------- *
 * Dirty flag
 * ---------------------------------------------------------------------- */

function markDirty_(reason) {
  var store = props_();
  var current = store.getProperty(PROP_DIRTY);
  var state = current ? JSON.parse(current) : { since: new Date().toISOString(), reasons: [] };

  if (state.reasons.indexOf(reason) === -1) state.reasons.push(reason);
  if (state.reasons.length > 25) state.reasons = state.reasons.slice(0, 25);

  store.setProperty(PROP_DIRTY, JSON.stringify(state));
}

function readDirty_() {
  var raw = props_().getProperty(PROP_DIRTY);
  return raw ? JSON.parse(raw) : null;
}

function clearDirty_() {
  props_().deleteProperty(PROP_DIRTY);
}

/* ---------------------------------------------------------------------- *
 * Edit trigger
 * ---------------------------------------------------------------------- */

function onEditHandler(e) {
  try {
    if (!e || !e.range) return;

    var sheet = e.range.getSheet();
    var name = sheet.getName();
    var rule = CFG.watch.editSheets[name];
    if (!rule) return;

    var firstCol = e.range.getColumn();
    var lastCol = e.range.getLastColumn();
    if (lastCol < rule.cols[0] || firstCol > rule.cols[1]) return;   // outside the watched span

    if (!rule.gate) {
      markDirty_(name + '!' + e.range.getA1Notation());
      return;
    }

    var firstRow = e.range.getRow();
    var numRows = e.range.getNumRows();
    var width = rule.cols[1];
    var values = sheet.getRange(firstRow, 1, numRows, width).getValues();

    for (var i = 0; i < values.length; i++) {
      if (rowQualifies_(values[i], rule, firstCol, lastCol)) {
        markDirty_(name + ' row ' + (firstRow + i));
        return;
      }
    }
  } catch (err) {
    // A throwing edit trigger is invisible to the user and blocks nothing —
    // record it and let the nightly safety net cover the missed rebuild.
    logTriggerError_('onEditHandler', err);
  }
}

/**
 * A row counts when it is complete, or when the edit just blanked one of the
 * cells that made it complete. Partial typing into an unfinished row does not.
 */
function rowQualifies_(rowValues, rule, editedFirstCol, editedLastCol) {
  var complete = true;
  for (var i = 0; i < rule.required.length; i++) {
    var col = rule.required[i];
    if (String(rowValues[col - 1] === undefined ? '' : rowValues[col - 1]).trim() === '') {
      complete = false;
      break;
    }
  }
  if (complete) return true;

  // Not complete — but if this edit cleared a required cell, that is a deletion
  // and the roster still needs to catch up.
  for (var j = 0; j < rule.required.length; j++) {
    var required = rule.required[j];
    if (required < editedFirstCol || required > editedLastCol) continue;
    if (String(rowValues[required - 1] === undefined ? '' : rowValues[required - 1]).trim() === '') {
      return true;
    }
  }
  return false;
}

/** Row inserts, deletes, and some paste shapes arrive here rather than onEdit. */
function onChangeHandler(e) {
  try {
    if (!e) return;
    var type = e.changeType;
    if (type !== 'INSERT_ROW' && type !== 'REMOVE_ROW' && type !== 'INSERT_GRID') return;

    var name = SpreadsheetApp.getActiveSheet().getName();
    if (!CFG.watch.editSheets[name]) return;

    markDirty_(name + ' ' + type);
  } catch (err) {
    logTriggerError_('onChangeHandler', err);
  }
}

/* ---------------------------------------------------------------------- *
 * Fingerprinting the imported ranges
 * ---------------------------------------------------------------------- */

var ERROR_TOKENS = {
  '#REF!': 1, '#N/A': 1, '#ERROR!': 1, '#VALUE!': 1,
  '#DIV/0!': 1, '#NAME?': 1, '#NUM!': 1, '#NULL!': 1
};

/**
 * @return {?string} null when the range is unreadable — an IMPORTRANGE that is
 *   erroring or still loading must not be fingerprinted, or a transient failure
 *   would look like a real change and rebuild the roster from nothing.
 */
function fingerprint_(ss, spec) {
  var sheet = ss.getSheetByName(spec.sheet);
  if (!sheet) return null;

  var values;
  try {
    values = sheet.getRange(spec.range).getValues();
  } catch (err) {
    return null;
  }

  var parts = [];
  var nonBlank = 0;

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var joined = [];
    var rowHasData = false;

    for (var c = 0; c < row.length; c++) {
      var v = row[c];
      if (v instanceof Date) v = v.toISOString();
      else v = String(v === null || v === undefined ? '' : v);

      if (ERROR_TOKENS[v]) return null;
      if (v !== '') rowHasData = true;
      joined.push(v);
    }

    if (rowHasData) {
      nonBlank++;
      parts.push(joined.join(''));
    }
  }

  if (!nonBlank) return null;   // empty import — treat as unreadable, not as "changed to nothing"

  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    parts.join(''),
    Utilities.Charset.UTF_8
  );

  var hex = '';
  for (var i = 0; i < digest.length; i++) {
    var byte = digest[i] < 0 ? digest[i] + 256 : digest[i];
    hex += (byte < 16 ? '0' : '') + byte.toString(16);
  }
  return nonBlank + ':' + hex;
}

/**
 * Compare every polled range against its stored fingerprint.
 * @return {Array<string>} the ranges that changed.
 */
function pollImports_(ss) {
  var store = props_();
  var changed = [];

  for (var i = 0; i < CFG.watch.hashRanges.length; i++) {
    var spec = CFG.watch.hashRanges[i];
    var key = PROP_HASH + spec.sheet;
    var current = fingerprint_(ss, spec);

    if (current === null) continue;          // unreadable this round; try again next tick

    var previous = store.getProperty(key);
    if (previous !== current) {
      store.setProperty(key, current);
      if (previous !== null) changed.push(spec.sheet);   // first run seeds, does not fire
    }
  }

  return changed;
}

/* ---------------------------------------------------------------------- *
 * The tick
 * ---------------------------------------------------------------------- */

function tick() {
  var ss = SpreadsheetApp.getActive();
  var store = props_();
  var reasons = [];

  var dirty = readDirty_();
  if (dirty) reasons = reasons.concat(dirty.reasons);

  var lastPoll = Number(store.getProperty(PROP_LAST_POLL) || 0);
  var due = (Date.now() - lastPoll) >= CFG.watch.pollMinutes * 60000;

  if (due) {
    store.setProperty(PROP_LAST_POLL, String(Date.now()));
    var changed = pollImports_(ss);
    for (var i = 0; i < changed.length; i++) reasons.push(changed[i] + ' (imported data changed)');
  }

  if (!reasons.length) return;

  clearDirty_();
  var summary = rebuildAll();
  summary.reasons = reasons;
  store.setProperty(PROP_LAST_BUILD, JSON.stringify({
    at: new Date().toISOString(),
    students: summary.students,
    guardians: summary.guardians,
    warnings: summary.warnings,
    seconds: summary.seconds,
    reasons: reasons
  }));
}

/**
 * Menu action: fingerprint the imported ranges right now, ignoring pollMinutes,
 * and rebuild if anything moved.
 *
 * Worth knowing what this can and cannot tell you. It compares what IMPORTRANGE
 * has currently pulled into this workbook, not what is in the source files. If
 * IMPORTRANGE has not refreshed yet, a change made moments ago in KIP Offers is
 * not visible here and this will correctly report "no change".
 */
function checkImportsNow() {
  var ss = SpreadsheetApp.getActive();
  var ui = SpreadsheetApp.getUi();

  props_().setProperty(PROP_LAST_POLL, String(Date.now()));

  var unreadable = [];
  for (var i = 0; i < CFG.watch.hashRanges.length; i++) {
    if (fingerprint_(ss, CFG.watch.hashRanges[i]) === null) {
      unreadable.push(CFG.watch.hashRanges[i].sheet);
    }
  }

  var changed = pollImports_(ss);

  if (unreadable.length) {
    ui.alert(
      'Cannot read: ' + unreadable.join(', ') + '\n\n' +
      'The range is erroring or empty, so it was skipped rather than treated as ' +
      'a change. Check the IMPORTRANGE authorization on those sheets.'
    );
    return;
  }

  if (!changed.length) {
    ui.alert(
      'No change since the last check.\n\n' +
      'Note this compares what IMPORTRANGE has already pulled into this ' +
      'workbook. If a change was made in a source file very recently, ' +
      'IMPORTRANGE may not have refreshed yet.'
    );
    return;
  }

  var summary = rebuildAll();
  clearDirty_();
  ui.alert(
    'Changed: ' + changed.join(', ') + '\n\n' +
    'Rebuilt in ' + summary.seconds + 's — ' +
    summary.students + ' students, ' + summary.guardians + ' guardians, ' +
    summary.warnings + ' warning(s).'
  );
}

/** Nightly backstop, so a missed event never leaves the roster stale for long. */
function nightlyRebuild() {
  var summary = rebuildAll();
  clearDirty_();
  props_().setProperty(PROP_LAST_BUILD, JSON.stringify({
    at: new Date().toISOString(),
    students: summary.students,
    guardians: summary.guardians,
    warnings: summary.warnings,
    seconds: summary.seconds,
    reasons: ['nightly safety net']
  }));
}

function logTriggerError_(where, err) {
  try {
    console.error(where + ': ' + (err && err.stack ? err.stack : err));
  } catch (ignored) {}
}

/* ---------------------------------------------------------------------- *
 * Install / remove
 * ---------------------------------------------------------------------- */

var MANAGED_HANDLERS = ['onEditHandler', 'onChangeHandler', 'tick', 'nightlyRebuild'];

function startWatching() {
  stopWatching();

  var ss = SpreadsheetApp.getActive();

  ScriptApp.newTrigger('onEditHandler').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('onChangeHandler').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(CFG.watch.tickMinutes).create();
  ScriptApp.newTrigger('nightlyRebuild').timeBased()
    .atHour(CFG.watch.safetyNetHour).everyDays(1).create();

  // Seed the fingerprints so the first poll compares against a known state
  // instead of reporting everything as changed.
  pollImports_(ss);
  clearDirty_();

  SpreadsheetApp.getUi().alert(
    'Watching started.\n\n' +
    '• Edits in ' + Object.keys(CFG.watch.editSheets).join(', ') +
      ' queue a rebuild.\n' +
    '• Rebuilds run at most once every ' + CFG.watch.tickMinutes + ' minutes.\n' +
    '• Imported data is checked every ' + CFG.watch.pollMinutes + ' minutes.\n' +
    '• A full rebuild runs nightly around ' + CFG.watch.safetyNetHour + ':00.'
  );
}

function stopWatching() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (MANAGED_HANDLERS.indexOf(triggers[i].getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function showWatchStatus() {
  var store = props_();
  var dirty = readDirty_();
  var lastBuild = store.getProperty(PROP_LAST_BUILD);
  var lastPoll = Number(store.getProperty(PROP_LAST_POLL) || 0);

  var installed = [];
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (MANAGED_HANDLERS.indexOf(triggers[i].getHandlerFunction()) !== -1) {
      installed.push(triggers[i].getHandlerFunction());
    }
  }

  var lines = [];
  lines.push('Triggers: ' + (installed.length ? installed.join(', ') : 'none installed'));
  lines.push('');
  lines.push('Pending rebuild: ' + (dirty
    ? 'yes — ' + dirty.reasons.join('; ')
    : 'no'));
  lines.push('Imports last checked: ' + (lastPoll ? new Date(lastPoll).toLocaleString() : 'never'));
  lines.push('');

  if (lastBuild) {
    var b = JSON.parse(lastBuild);
    lines.push('Last build: ' + new Date(b.at).toLocaleString());
    lines.push('  ' + b.students + ' students, ' + b.guardians + ' guardians, ' +
      b.seconds + 's, ' + b.warnings + ' warning(s)');
    lines.push('  triggered by: ' + (b.reasons || []).join('; '));
  } else {
    lines.push('Last build: never (run "Rebuild now" once to seed).');
  }

  SpreadsheetApp.getUi().alert(lines.join('\n'));
}
