/**
 * TEST BUILD — the same script with every Gmail call removed.
 *
 * Its only purpose is to answer one question: is the "Google hasn't verified
 * this app" warning caused by the Gmail scope alone?
 *
 * Reading Gmail is a *restricted* scope, the highest tier Google has. Writing
 * this spreadsheet and fetching a URL are not. So if the warning disappears
 * here, the Gmail half can move to a platform whose Google connection is
 * already verified, and nobody ever sees a red screen.
 *
 * Everything below is lifted unchanged from the real script. Nothing was
 * simplified, so the test measures the scopes and not a different program.
 *
 * Paste this in place of the real code, run "Portfolio Sync > Set up", and
 * screenshot whatever Google shows.
 */

const ENDPOINT = 'https://portfolio-sync-shared.vercel.app';

const TX = 'Transactions';
const HOLDINGS = 'Holdings Summary';
const HISTORY = 'History';
const TAX_YEARS = 'Tax Years';
const RUN_LOG = 'Run Log';

const TX_FIRST_ROW = 5;
const TX_LAST_COL = 9;
const HOLD_FIRST_ROW = 5;
const PRICE_COL = 13;

const MARKET_WATCH = 'https://dps.psx.com.pk/market-watch';


function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Portfolio Sync')
    .addItem('Set up', 'setUp')
    .addItem('Sync now', 'syncNow')
    .addSeparator()
    .addItem('Stop daily sync', 'stopDaily')
    .addToUi();
}

function setUp() {
  stopDaily();
  ScriptApp.newTrigger('dailySync').timeBased().atHour(21).everyDays(1).create();
  SpreadsheetApp.getActiveSpreadsheet().toast('Set up (test build - no Gmail).',
    'Portfolio Sync', 8);
  sync();
}

function syncNow() { sync(); }
function dailySync() { sync(); }

function stopDaily() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function sync() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet();
  const notes = [];
  try {
    const priced = safely(notes, 'prices', function () { return refreshPrices(sheet); });
    safely(notes, 'history', function () { return writeSnapshot(sheet); });
    safely(notes, 'tax years', function () { return writeTaxYears(sheet); });
    checkEveryScripIsTracked(sheet, notes);
    log(sheet, 'TEST BUILD (no Gmail) | ' +
      (priced === null ? 'prices unchanged' : priced + ' prices updated') +
      (notes.length ? ' | ' + notes.join(' ; ') : ''));
  } catch (err) {
    log(sheet, 'TEST RUN FAILED: ' + err);
    throw err;
  }
}

function safely(notes, what, fn) {
  try { return fn(); } catch (err) { notes.push(what + ' failed: ' + err); return null; }
}


/* --------------------------------------------------------------- sheet -- */

function lastDataRow(sheet) {
  const tab = sheet.getSheetByName(TX);
  const column = tab.getRange(TX_FIRST_ROW, 1, Math.max(tab.getMaxRows() - TX_FIRST_ROW, 1), 1)
    .getValues();
  let last = TX_FIRST_ROW - 1;
  for (let i = 0; i < column.length; i++) {
    if (column[i][0] !== '' && column[i][0] !== null) last = TX_FIRST_ROW + i;
  }
  return last;
}

function findTotalRow(tab) {
  const column = tab.getRange(1, 1, tab.getMaxRows(), 1).getValues();
  for (let i = 0; i < column.length; i++) {
    if (String(column[i][0]).trim().toUpperCase() === 'TOTAL') return i + 1;
  }
  throw new Error('Holdings Summary has no TOTAL row');
}

function checkEveryScripIsTracked(sheet, notes) {
  const last = lastDataRow(sheet);
  if (last < TX_FIRST_ROW) return;

  const traded = {};
  sheet.getSheetByName(TX).getRange(TX_FIRST_ROW, 2, last - TX_FIRST_ROW + 1, 1)
    .getValues().forEach(function (r) {
      if (r[0]) traded[String(r[0]).trim().toUpperCase()] = true;
    });

  const tab = sheet.getSheetByName(HOLDINGS);
  const tracked = {};
  tab.getRange(HOLD_FIRST_ROW, 1, findTotalRow(tab) - HOLD_FIRST_ROW, 1)
    .getValues().forEach(function (r) {
      if (r[0]) tracked[String(r[0]).trim().toUpperCase()] = true;
    });

  const missing = Object.keys(traded).filter(function (s) { return !tracked[s]; });
  if (missing.length) notes.push('NOT COUNTED in Holdings Summary: ' + missing.join(', '));
}


/* -------------------------------------------------------------- prices -- */

function fetchPrices() {
  const html = UrlFetchApp.fetch(MARKET_WATCH, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }).getContentText();

  const head = /<thead[\s\S]*?<\/thead>/i.exec(html);
  if (!head) throw new Error('market-watch has no header row');
  const columns = (head[0].match(/data-name="([^"]*)"/g) || [])
    .map(function (m) { return m.slice(11, -1); });
  const symbolAt = columns.indexOf('symbol');
  const closeAt = columns.indexOf('close');
  if (symbolAt < 0 || closeAt < 0) throw new Error('market-watch changed shape');

  const prices = {};
  (html.match(/<tr>[\s\S]*?<\/tr>/g) || []).forEach(function (row) {
    const cells = (row.match(/<td[\s\S]*?<\/td>/g) || []).map(function (cell) {
      const order = /data-order="([^"]*)"/.exec(cell);
      return order ? order[1] : cell.replace(/<[^>]*>/g, '').trim();
    });
    if (cells.length <= Math.max(symbolAt, closeAt)) return;
    const value = parseFloat(cells[closeAt]);
    if (!isNaN(value)) prices[cells[symbolAt].trim().toUpperCase()] = value;
  });

  if (!Object.keys(prices).length) throw new Error('market-watch returned no prices');
  return prices;
}

function refreshPrices(sheet) {
  const prices = fetchPrices();
  const tab = sheet.getSheetByName(HOLDINGS);
  const slots = findTotalRow(tab) - HOLD_FIRST_ROW;

  const scrips = tab.getRange(HOLD_FIRST_ROW, 1, slots, 1).getValues();
  const column = tab.getRange(HOLD_FIRST_ROW, PRICE_COL, slots, 1).getValues();

  let updated = 0;
  for (let i = 0; i < slots; i++) {
    const scrip = String(scrips[i][0]).trim().toUpperCase();
    if (scrip && prices[scrip] !== undefined) { column[i][0] = prices[scrip]; updated++; }
  }
  tab.getRange(HOLD_FIRST_ROW, PRICE_COL, slots, 1).setValues(column);
  return updated;
}


/* ------------------------------------------------------ history & tax -- */

function writeSnapshot(sheet) {
  const tab = sheet.getSheetByName(HISTORY);
  const holdings = sheet.getSheetByName(HOLDINGS);
  const t = holdings.getRange(findTotalRow(holdings), 1, 1, 24).getValues()[0];

  const invested = Number(t[13]) || 0;
  const row = [
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    invested, Number(t[14]) || 0, Number(t[15]) || 0,
    Number(t[11]) || 0, Number(t[10]) || 0, Number(t[16]) || 0,
    invested ? (Number(t[16]) || 0) / invested : 0
  ];

  const dates = tab.getRange(2, 1, Math.max(tab.getLastRow() - 1, 1), 1).getValues();
  for (let i = 0; i < dates.length; i++) {
    if (String(dates[i][0]).slice(0, 10) === row[0]) {
      tab.getRange(i + 2, 1, 1, row.length).setValues([row]);
      return 'updated';
    }
  }
  tab.getRange(Math.max(tab.getLastRow() + 1, 2), 1, 1, row.length).setValues([row]);
  return 'added';
}

function writeTaxYears(sheet) {
  const last = lastDataRow(sheet);
  if (last < TX_FIRST_ROW) return 0;

  const rows = sheet.getSheetByName(TX)
    .getRange(TX_FIRST_ROW, 1, last - TX_FIRST_ROW + 1, TX_LAST_COL).getValues()
    .map(function (r) {
      const when = r[0] instanceof Date
        ? Utilities.formatDate(r[0], Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(r[0]).slice(0, 10);
      return [when, r[1], r[3], r[4], r[6], r[7]];
    });

  const result = post('/analyze', { transactions: rows });
  const tab = sheet.getSheetByName(TAX_YEARS);

  const values = result.tax_years.map(function (y) {
    return [y.label, y.sales, y.proceeds, y.cost, y.adjustments, y.realised];
  });
  values.push(['TOTAL', '', '', '', '', result.total_realised]);
  values.push(['']);
  values.push(['Tax year runs 1 July to 30 June, named for the year it ends in.']);
  values.push(['A record of what was realised and when — not tax advice.']);
  (result.notes || []).forEach(function (n) { values.push(['CHECK: ' + n]); });

  tab.getRange(2, 1, 200, 8).clearContent();
  tab.getRange(2, 1, values.length, 6).setValues(values.map(function (v) {
    while (v.length < 6) v.push('');
    return v;
  }));
  return result.tax_years.length;
}


/* ----------------------------------------------------------- plumbing -- */

function post(path, payload) {
  const response = UrlFetchApp.fetch(ENDPOINT + path, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(path + ' returned ' + code + ': ' + response.getContentText().slice(0, 300));
  }
  return JSON.parse(response.getContentText());
}

function log(sheet, message) {
  const tab = sheet.getSheetByName(RUN_LOG);
  if (!tab) return;
  tab.appendRow([
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    message
  ]);
}
