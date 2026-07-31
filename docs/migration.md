# Migration: formulas → Apps Script

Precise steps, in order. Read §0 before touching anything.

**The split.** Ingestion stays as formulas. Parsing and output move to script.

| Sheet / range | After migration |
| --- | --- |
| `Imported Master Copy 25-26` | formula (consolidated to one IMPORTRANGE) |
| `New Students 2026` | formula (unchanged) |
| `PASTE SHEET` `N:W`, `X:AG` | formula (small robustness fixes) |
| `OUTPUTTED SHEET` `A:J` | formula (rewritten with `LET`) |
| `OUTPUTTED SHEET` `K:P` | **script** |
| `Parents Divided3` `A:N` | **script** |
| `Table` `A5:G` | **script** |
| `Phone Contacts` `A:AU` | **script** |

Ingestion stays formula-based because IMPORTRANGE is doing real work and is
low-risk. The parsing layer moves because seven regex columns re-derive the
same guardian structure seven different ways, and five of them get it wrong.

---

## 0. Before you start

1. **File → Make a copy.** Step 2 deletes formulas permanently.
2. Note your current row counts (students, `Parents Divided3` rows). You will
   compare against these after the first build.

---

## 1. Install the script

Extensions → Apps Script, then create one file per `src/*.gs` and paste the
contents. File order does not matter — Apps Script shares one global scope.

If you use `clasp`: `clasp clone <scriptId>` into `src/`, then `clasp push`.

Then run **KIP → Run parser tests** once. It should report *All parser tests
passed*. If the menu is missing, reload the spreadsheet.

---

## 2. Delete the formulas the script now owns

The script clears and rewrites these ranges. Leftover array formulas will
collide with the write and produce `#REF!`.

| Sheet | Delete |
| --- | --- |
| `Parents Divided3` | `A2`, `C2`, `D2`, `E2`, `F2`, `G2`, `H2`, `I2`, `J2`, `K2`, `L2`, `M2`, `N2` |
| `OUTPUTTED SHEET` | `K2:P2` (and any dragged copies below) |
| `Table` | `A5`, `G5` |
| `Phone Contacts` | `A2`, `C2`, `E2`, `L2`…`Y2` (and dragged copies) |

Keep row 1 headers everywhere, and keep `Table` rows 1–4.

`Table!B1` becomes decorative — the script reads `OUTPUTTED SHEET` directly
rather than through `INDIRECT`, which also resolves the `B1` vs `B2`
discrepancy in the old `A5`.

---

## 3. First build

**KIP → Rebuild now.**

Check the counts in the confirmation against your §0 notes, then open the
**Build Log** tab. Every parsing problem the old formulas hid behind `IFERROR`
now appears there. Expect some rows on the first run — that is the point.

| Log message | Meaning |
| --- | --- |
| `Could not parse line` | A line in G/H/I is neither a guardian nor a usable value — genuine junk worth looking at |
| `has contacts but no entry in column G` | A guardian slot appears in H or I but not the roster |
| `named "X" in column G but "Y" alongside its contacts` | The name differs between lines for one slot |
| `two values for Contact N; ... moved to position M` | Two values claimed the same slot; both were kept |
| `more values than the N available columns` | More emails or phones than there are columns |
| `students were grouped into one household` | Probably a shared office number or placeholder email |
| `has a relationship but no name in the source` | e.g. `*Guardian 1 -  (Parent)` — the contacts were kept, the name is genuinely missing upstream |
| `stood on its own line with no guardian named above it` | A bare value opened the blob; it was attached to the first slot by position |

### Two report tabs

Each build writes both:

**`Build Log`** — the full record, with real names, emails, phones and OSIS.
Columns: When, Level, Code, OSIS, Where, Message, Source line. The `Source
line` column holds the offending text verbatim, which is usually the fastest
way to see what went wrong.

**`Build Log (Shareable)`** — the same findings with every identifying value
removed, safe to send outside the school. It opens with a summary counting
findings by code, then the detail rows.

Anonymisation is *structural*: the shape of a line survives, the content does
not.

```
*Guardian 1 - SHELLY BAYNE (Parent) - (917) 312-0601
*Guardian 1 - AAAAAA AAAAA (Parent) - (999) 999-9999
```

| Kept | Removed |
| --- | --- |
| Punctuation, spacing, dashes, asterisks, parentheses | Names → `A` / `a` by letter |
| `Guardian` and `Contact` plus their slot numbers | Emails → `aaaa@aaaaa.aaa` |
| Relationship and language words | Phone digits → `9` |
| Letter case and token lengths | OSIS → `S001`, `S002`, … |

Student references are sequential within a single report and meaningless
outside it, so findings about the same student can be correlated with each
other and with nothing else. Because token lengths survive, a wrapped name
still looks wrapped and a malformed phone still looks malformed — which is
the entire diagnostic.

The relationship and language words that survive are a fixed list in
`Anonymize.gs` (`KEEP_WORDS`). Anything not on it is masked, so an unusual
relationship label will show up as `Aaaaaa` rather than leaking; add it to the
list if you want it visible.

### Format variants the parser handles

The blobs are hand-maintained, so several shapes show up beyond the common
one. All of these are parsed; none of them log.

| Variant | Example |
| --- | --- |
| Unlabeled value | `*Guardian 1 - SHELLY BAYNE (Parent) - (917) 312-0601` — no `Contact N:` |
| Continuation value | a bare `6462763207` on its own line, belonging to the guardian above |
| Wrapped name | `SUYEON LII` / `KIM (Parent)` split across two lines, sometimes with no `Guardian N` prefix at all |
| Several values in one slot | `Contact 1: JONATHAN.LII@GMAIL.COM SUYEON.K.LII@GMAIL.COM` |
| Nameless guardian | `*Guardian 1 -   (Parent)` — a slot and a relationship with no name |
| Leading bare value | a blob whose first line is just an email or phone, with no guardian above it |

The last two still log, because both are real upstream problems worth seeing —
but they log **once**, accurately, and the contact data is kept either way. A
nameless guardian used to be rejected outright, which made its roster line read
as unparseable *and* its contact line read as an orphan slot: one problem,
reported twice, under two wrong names.

Parsing is kind-aware, which is what keeps this from over-reaching: the email
blob only accepts text containing `@` as a loose value, and the phone blob only
accepts something with at least seven digits. So `1110` and `71- Ariel` are
still reported as unparseable rather than being absorbed into a name or written
into a contact column. An area code is also never mistaken for a relationship —
`(917)` is skipped, `(Parent)` is used.

---

## 4. Turn on change detection

**KIP → Start watching.** This installs four triggers and seeds the
fingerprints.

Two mechanisms, because the sources differ in kind:

**Edits in this workbook** — `Non-Student`, `PASTE SHEET`, `REMOVE Discharge`
get an installable `onEdit` trigger, plus `onChange` for row inserts and
deletes.

**Imported data** — `Imported Master Copy 25-26` and `New Students 2026` are
fed by IMPORTRANGE from other spreadsheets. **Apps Script cannot receive an
edit trigger for a file it is not bound to**, so there is no event to hook.
These are polled: the range is fingerprinted (MD5 over its values) and
compared to the previous fingerprint. Different fingerprint → rebuild.

> **`onEdit` does not fire on recalculation.** It fires when a person edits a
> cell in this workbook — nothing else. A value that changes because
> IMPORTRANGE refreshed, because a formula recalculated, or because a script
> wrote to the cell produces no event. `onChange` does not cover it either;
> that is for structural changes like row inserts. This is the entire reason
> the polling half exists.

Nothing rebuilds inline. Edits and polls set a dirty flag; `tick()` drains it.
Pasting fifty rows fires `onEdit` fifty times and produces **one** rebuild.

### The "wait until the row is finished" rule

An edit only queues a rebuild when the row's required columns are all filled:

- typing into a half-built row does nothing
- filling the last required cell queues a rebuild
- any later edit to a row that is already complete queues one too
- clearing a required cell also queues one, so deletions are not missed

**I set `required` to A, B, C, D (OSIS, Last, First, OSIS)** rather than all of
A:J, because `Class/Teacher` and the guardian blobs are legitimately blank on
plenty of rows and gating on them would mean those rows never trigger a
rebuild at all. To require the full span instead, edit `CFG.watch.editSheets`
in `Config.gs`:

```js
'Non-Student': { cols: [1, 12], required: [1,2,3,4,5,6,7,8,9,10], gate: true },
```

### Timing

| Setting | Default | Effect |
| --- | --- | --- |
| `tickMinutes` | 5 | Longest wait between an edit and its rebuild |
| `pollMinutes` | 30 | How often imported ranges are fingerprinted |
| `safetyNetHours` | 6 | Unconditional rebuild, regardless of flags |
| `staleAfterHours` | 14 | Watch status warns past this age |

`safetyNetHours` accepts 1, 2, 4, 6, 8, or 12 — Apps Script does not allow
arbitrary hourly intervals.

Polling faster than 30 minutes buys nothing: IMPORTRANGE refreshes on its own
schedule, so the local mirror will not show a change until it does. Worst-case
latency for a change made in an external spreadsheet is IMPORTRANGE's refresh
plus one poll interval.

**KIP → Watch status** shows installed triggers, any pending rebuild, when the
imports were last checked, and what triggered the last build.

**KIP → Check imports for changes now** forces a fingerprint comparison
immediately, ignoring `pollMinutes`, and rebuilds if anything moved. Use it
when you know a source file changed and do not want to wait for the poll.

### A limit of polling the mirror

The fingerprint is taken of what IMPORTRANGE has **already pulled into this
workbook** — not of the source file. So the chain has two independent delays:

```
edit in KIP Offers
      ↓  IMPORTRANGE refreshes on Google's schedule   ← not under our control
new value appears in New Students 2026
      ↓  next poll (≤ pollMinutes)                    ← ours
rebuild
```

The first hop is the weak one. IMPORTRANGE results are cached server-side and
refresh on recalculation; a workbook that nobody has open may not recalculate
promptly. If the mirror is stale, "Check imports for changes now" will
correctly report *no change* — it is reporting on the mirror, faithfully.

The deterministic fix is for the script to read the source spreadsheets
directly with `SpreadsheetApp.openById`, which is never cached and never
stale. That would mean the script builds the roster union itself rather than
reading `OUTPUTTED SHEET!A:J`, absorbing `Imported Master Copy 25-26`,
`New Students 2026`, `PASTE SHEET!X:AG` and the `A2` union formula. See
"Design decisions" below.

### Safety interlocks

**Unreadable ranges are skipped, not acted on.** When a polled range reads
`#REF!`, `#N/A`, or comes back with zero non-blank rows, it is treated as
unreadable and left alone. A revoked IMPORTRANGE authorization would otherwise
look like "all students deleted" and write an empty roster over everything.

**A failed rebuild does not lose its trigger.** The dirty flag and any new
fingerprints are committed only *after* `rebuildAll()` returns. If it throws,
both survive, the next tick retries, and the exception still propagates so
Google sends its own failure notification. Without this the sequence
"change detected → fingerprint stored → rebuild crashes" would record the new
fingerprint against an un-rebuilt sheet and never notice that change again.

**Every 6 hours it rebuilds anyway.** `safetyNetRebuild` does not consult the
dirty flag, the fingerprints, or anything else — it just rebuilds. This is the
ceiling on staleness, and it covers the failure modes the other mechanisms
cannot see: a missed `onEdit`, an IMPORTRANGE that refreshed without changing
the fingerprint window, a trigger that got disabled, or a run of failed
rebuilds. Afterwards it re-seeds the fingerprints so the next poll compares
against what was actually built.

**Watch status surfaces trouble.** It flags a last-successful-build older than
`staleAfterHours`, reports the last failure and its message, and warns if the
safety-net trigger is missing while the others are installed.

---

## 5. Optimise the formulas that remain

Optional, but each one removes a real failure mode.

### `Imported Master Copy 25-26` — four IMPORTRANGEs become one

Currently `A2`, `B2`, `D2`, `H2`, and `J3` are five formulas making four
separate IMPORTRANGE calls to the same file, with column C fetched twice.

Delete all five and put this in **`A3`**:

```
=LET(
  src, IMPORTRANGE("https://docs.google.com/spreadsheets/d/192lRLf8gdVK9xLvnOGR3CECl7xIvyvRcBF0tWjhAlg4/edit", "'Master Copy'!A2:H"),
  data, FILTER(src, CHOOSECOLS(src, 3) <> ""),
  HSTACK(
    CHOOSECOLS(data, 3),
    ARRAYFORMULA(REGEXREPLACE(TO_TEXT(CHOOSECOLS(data, 1, 2)), "\*", "")),
    CHOOSECOLS(data, 3, 4, 5, 6, 7, 8),
    MAKEARRAY(ROWS(data), 1, LAMBDA(r, c, "MASTER"))
  )
)
```

Same layout as before — A = `Master!C`, B:C = `Master!A:B` with asterisks
stripped, D:G = `Master!C:F`, H:I = `Master!G:H`, J = `"MASTER"` — but one
fetch, one cache entry, one authorization to keep alive. Importing `A2:H`
rather than `A1:H` drops the source header row, so data starts at row 3 and
`OUTPUTTED SHEET`'s `A3:J` reference is unchanged.

### `OUTPUTTED SHEET!A2` — build the union once

The current formula constructs the same three-way `VSTACK` three times.

```
=LET(
  all, VSTACK(
    'Imported Master Copy 25-26'!A3:J,
    'PASTE SHEET'!X2:AG,
    'PASTE SHEET'!N2:W
  ),
  ids, CHOOSECOLS(all, 1),
  FILTER(all, ids <> "", ISNA(MATCH(ids, 'REMOVE Discharge'!A2:A, 0)))
)
```

`ISNA(MATCH(...))` replaces `NOT(COUNTIF(...))`: it stops scanning at the first
hit, and it does not treat `?` and `*` in an OSIS as wildcards.

### `PASTE SHEET!X2` — stop hiding IMPORTRANGE failures

One-character fix, `IFERROR` → `IFNA`:

```
=LET(
  d1, IFNA(FILTER('Non-Student'!A2:J, TRIM('Non-Student'!L2:L) = ""), {"","","","","","","","","",""}),
  d2, IFNA(FILTER('New Students 2026'!A2:J, 'New Students 2026'!A2:A <> ""), {"","","","","","","","","",""}),
  all, VSTACK(d1, d2),
  FILTER(all, CHOOSECOLS(all, 1) <> "")
)
```

`FILTER` with no matches returns `#N/A`, which is the case the fallback is
for. A broken IMPORTRANGE returns `#REF!`, which now surfaces instead of being
silently converted into "zero new students."

### `PASTE SHEET!N2` — label the rows and drop blanks

`A2:I` is nine columns spilling into a ten-column block, so the Label column is
always empty. Those rows then reach `Phone Contacts` with no label.

```
=LET(
  keep, FILTER(A2:I, (K2:K = FALSE) * (A2:A <> "") * ISNA(MATCH(A2:A, X2:X, 0))),
  IFNA(UNIQUE(HSTACK(keep, MAKEARRAY(ROWS(keep), 1, LAMBDA(r, c, "PASTE")))))
)
```

The `"PASTE"` label makes these rows traceable and gives `Phone Contacts` a
meaningful name prefix. The script trims the prefix either way, so this is
cosmetic — but it also tells you at a glance which roster a contact came from.

---

## 6. Rollback

Revert to the §0 copy. The script only writes the four ranges in the table at
the top of this document plus the `Build Log` tab; nothing else is touched.

To stop automation without reverting: **KIP → Stop watching**. The sheets keep
their last built values.

---

## Design decisions

**Detection is incremental; the rebuild is not.** Sibling grouping is a global
computation — adding one student can change the household of a student
elsewhere in the sheet. A row-level partial rebuild would produce wrong
households, so `tick()` decides *whether* to rebuild and then rebuilds
everything. At roughly 600 students and 1,000 guardians that is a couple of
seconds of a single read and four writes.

**IMPORTRANGE stays, for now.** Apps Script could read the source files
directly with `SpreadsheetApp.openById`. That removes both the polling latency
and the staleness risk described in §4, because a direct read is never cached.

The cost is that it is no longer a small change. `OUTPUTTED SHEET!A:J` is
currently a formula reading two IMPORTRANGE-fed sheets; making the script
authoritative means it also owns `Imported Master Copy 25-26`,
`New Students 2026`, `PASTE SHEET!X:AG`, and the `A2` union — so those sheets
stop being live and become script output like the rest. It also needs the
broader `spreadsheets` OAuth scope instead of `spreadsheets.currentonly`.

Worth doing if roster changes need to land in minutes rather than within the
hour. Not worth doing if the nightly rebuild plus a manual **Check imports for
changes now** covers the workflow.

**Contacts are placed by slot number, not compacted.** `Parents Divided3`
column headers name K through N *mobile, secondary, third, fourth*, so
`Contact 2:` belongs in `secondary_phone` even when `Contact 1:` is absent.
This also removes the old `Contact 1 → fall back to Contact 2` rule in `K2`,
which was what put the same number in both K and L. `Phone Contacts` *does*
compact, because a Google Contacts row with an empty Phone 1 and a filled
Phone 2 imports awkwardly.

**Slot number is the join key.** Guardian identity comes from column G; H and I
contribute contacts to whichever slot they name. A name that disagrees between
lines is logged, never used to split a slot or drop a contact.
