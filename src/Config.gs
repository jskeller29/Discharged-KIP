/**
 * Central configuration. Everything positional lives here so a column move is a
 * one-line edit rather than a hunt through the codebase.
 */

var CFG = {

  sheets: {
    outputted: 'OUTPUTTED SHEET',
    parents:   'Parents Divided3',
    table:     'Table',
    contacts:  'Phone Contacts',
    log:       'Build Log'
  },

  /**
   * Change detection. Two mechanisms, because the sources differ in kind:
   *
   *   editSheets  live in THIS workbook, so an installable onEdit trigger sees
   *               them directly.
   *   hashRanges  are fed by IMPORTRANGE from other spreadsheets. Apps Script
   *               cannot receive edit events for a file it is not bound to, so
   *               these are polled: the range is fingerprinted and compared to
   *               the previous fingerprint.
   *
   * Either mechanism only decides WHETHER to rebuild. The rebuild itself is
   * always whole-workbook — sibling grouping is a global computation, so a
   * row-level partial rebuild would produce wrong households.
   */
  watch: {

    /**
     * cols        the column span a user actually edits (formula output is
     *             ignored — onEdit does not fire on recalculation).
     * required    columns that must all be non-blank before an edit counts.
     *             This is the "wait until the row is finished" gate: typing
     *             into a half-built row does nothing, completing the last
     *             required cell queues a rebuild, and any later edit to a
     *             row that is already complete queues one too.
     *             Clearing a required cell also counts, so deletions are seen.
     * gate        set false to rebuild on any edit in the span.
     */
    editSheets: {
      'Non-Student':      { cols: [1, 12], required: [1, 2, 3, 4], gate: true },
      'PASTE SHEET':      { cols: [1, 11], required: [1, 2, 3, 4], gate: true },
      'REMOVE Discharge': { cols: [1, 1],  required: [1],          gate: false }
    },

    /** Polled ranges. Bounded rows keep the fingerprint read cheap. */
    hashRanges: [
      { sheet: 'Imported Master Copy 25-26', range: 'A3:J5000' },
      { sheet: 'New Students 2026',          range: 'A2:J5000' }
    ],

    /** How often tick() runs. Allowed: 1, 5, 10, 15, 30. */
    tickMinutes: 5,

    /**
     * How often tick() bothers to fingerprint the imported ranges. Edits in
     * this workbook rebuild on the next tick regardless; this only paces the
     * polling half. IMPORTRANGE refreshes on its own schedule, so polling
     * faster than it refreshes buys nothing.
     */
    pollMinutes: 30,

    /**
     * A rebuild that runs on a fixed schedule regardless of flags, so a missed
     * event or a failed rebuild cannot leave the roster stale indefinitely.
     * This is the ceiling on how wrong the sheet can be.
     * Allowed values: 1, 2, 4, 6, 8, 12.
     */
    safetyNetHours: 6,

    /** Watch status warns when the last successful build is older than this. */
    staleAfterHours: 14
  },

  /**
   * OUTPUTTED SHEET.
   * A:J stay formula-driven (the union of Imported Master Copy + PASTE SHEET).
   * K:P are written by this script.
   */
  outputted: {
    firstDataRow: 2,
    readCols: 10,          // A:J
    col: {                 // 1-based, within the A:J block
      osisA:      1,
      lastName:   2,
      firstName:  3,
      osisD:      4,       // canonical student id (same value as osisA)
      site:       5,
      classRoom:  6,
      parentName: 7,       // guardian roster blob
      email:      8,       // guardian email blob
      cell:       9,       // guardian phone blob
      label:      10
    },
    writeFirstCol: 11,     // K
    writeCols: 6           // K:P
  },

  /** Parents Divided3 — fully script-written, A:N. */
  parents: {
    firstDataRow: 2,
    cols: 14,
    maxEmails: 3,          // H, I, J
    maxPhones: 4           // K, L, M, N
  },

  /** Table — header at row 4, data from row 5, A:G. */
  table: {
    firstDataRow: 5,
    cols: 7,
    rowDelim: '《§ROW§》',   // 《§ROW§》
    colDelim: '《§COL§》'    // 《§COL§》
  },

  /** Phone Contacts — Google Contacts CSV layout, A:AU. */
  contacts: {
    firstDataRow: 2,
    cols: 47,
    col: {                 // 1-based
      osis:       1,
      firstName:  3,
      lastName:   5,
      email1Lbl: 12, email1Val: 13,
      email2Lbl: 14, email2Val: 15,
      email3Lbl: 16, email3Val: 17,
      phone1Lbl: 18, phone1Val: 19,
      phone2Lbl: 20, phone2Val: 21,
      phone3Lbl: 22, phone3Val: 23,
      phone4Lbl: 24, phone4Val: 25,
      labels:    47
    }
  },

  /**
   * When a guardian slot carries more contacts than there are output columns,
   * or a household groups more students than this, it lands in the Build Log.
   */
  limits: {
    suspiciousHouseholdSize: 6
  },

  /** Default when the parenthetical carries a relationship but no language. */
  defaultLanguage: 'English'
};
