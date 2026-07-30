# Discharged-KIP

Google Apps Script project for a Google Sheets student/roster workbook.

- `.gs` files are Apps Script server-side code (JavaScript on Google's servers)
- `.html` files are dialog/sidebar UIs served via `HtmlService`
- Frontend HTML talks to backend `.gs` functions via `google.script.run`
- No build step and no modules — all `.gs` files share one global scope

## Layout

| Path | What it is |
| --- | --- |
| `src/Config.gs` | All sheet names, column positions, and watch settings |
| `src/Parse.gs` | Guardian-blob parsing. Pure functions, no `SpreadsheetApp` |
| `src/Model.gs` | Builds students + guardians; sibling/household grouping |
| `src/Render.gs` | Renders the four script-owned output blocks |
| `src/Main.gs` | Menu, build orchestration, Build Log |
| `src/Triggers.gs` | Change detection: `onEdit` for local sheets, polling for imports |
| `src/Tests.gs` | Parser and edit-gate assertions — **KIP → Run parser tests** |

## Docs

- [`docs/sheet-architecture.md`](docs/sheet-architecture.md) — data flow, per-sheet
  inventory, and the formula audit (findings F-00 … F-12)
- [`docs/migration.md`](docs/migration.md) — cutover steps, trigger setup, and the
  optimised formulas for the ingestion layer that stays formula-based

## The split

Ingestion stays as formulas (IMPORTRANGE → `New Students 2026` / `Imported Master
Copy 25-26` → `PASTE SHEET` → `OUTPUTTED SHEET!A:J`).

Parsing and output are script-owned: `Parents Divided3`, `OUTPUTTED SHEET!K:P`,
`Table`, and `Phone Contacts`.

## Running the tests outside Apps Script

`Parse.gs`, `Model.gs`, and `Render.gs` touch no Apps Script globals, so the suite
runs under Node with two small stubs:

```sh
cat src/Config.gs src/Parse.gs src/Model.gs src/Render.gs \
    src/Main.gs src/Triggers.gs src/Tests.gs > /tmp/all.js
cat >> /tmp/all.js <<'JS'
var Logger = { log: function (m) { console.log(m); } };
var SpreadsheetApp = { getUi: function () { throw new Error('headless'); } };
if (runParserTests().length) process.exit(1);
JS
node /tmp/all.js
```
