/**
 * Portfolio Sync — keeps this spreadsheet up to date on its own.
 *
 * This runs inside YOUR Google account. It reads your broker's confirmation
 * emails, writes the trades into this sheet, and refreshes prices from the
 * Pakistan Stock Exchange. No password of yours goes anywhere.
 *
 * The one thing Apps Script cannot do is read a PDF, so the confirmation is
 * sent to a small service that reads it and sends the rows back. That service
 * holds no credentials, cannot see this spreadsheet or your mail, and keeps
 * nothing. Prices are fetched by this script directly, so your market data
 * never passes through anyone else either.
 *
 * Setup: menu "Portfolio Sync" > "Set up". Nothing else, ever.
 */

const ENDPOINT = 'https://portfolio-sync-shared.vercel.app';
const BROKER = 'akd';
// The same three values /brokers returns. Kept local so finding mail never
// depends on the network; a broker dropdown would set all three together.
const SENDER = 'confirmation@akdsl.com';
const SUBJECT = 'Trade Confirmation';

const TX = 'Transactions';
const HOLDINGS = 'Holdings Summary';
const LISTS = 'Lists';
const HISTORY = 'History';
const TAX_YEARS = 'Tax Years';
const RUN_LOG = 'Run Log';

const TX_FIRST_ROW = 5;
const TX_LAST_COL = 9;          // A..I are ours; J..P are formulas
const HELPER_FIRST_COL = 10;    // J
const HELPER_COL_COUNT = 7;     // J..P

const HOLD_FIRST_ROW = 5;
const PRICE_COL = 13;           // M

const RECENT_DAYS = 7;          // a missed night is picked up the next one
const PDFS_PER_CALL = 40;       // one request to the parse service
const TIME_BUDGET_MS = 4 * 60 * 1000;   // Apps Script stops us at six



/* ---------------------------------------------------------------- menu -- */

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

  const props = PropertiesService.getDocumentProperties();
  props.deleteProperty('pending');
  props.deleteProperty('firstRunDone');

  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Set up. Now loading your full history from Gmail — this can take a few minutes.',
    'Portfolio Sync', 10);
  sync();
}

function syncNow() { sync(); }
function dailySync() { sync(); }
function continueSync() { sync(); }

function stopDaily() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}


/* ---------------------------------------------------------------- sync -- */

function sync() {
  const started = Date.now();
  const sheet = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getDocumentProperties();
  const notes = [];
  let added = 0;

  try {
    // The first run reaches back as far as Gmail goes, so the whole portfolio
    // appears at once. After that only the last few days matter.
    const firstRun = props.getProperty('firstRunDone') !== 'yes';
    let pending = JSON.parse(props.getProperty('pending') || 'null');
    if (pending === null) {
      pending = findConfirmations(firstRun ? null : RECENT_DAYS);
    }
    const totalPending = pending.length;

    while (pending.length && Date.now() - started < TIME_BUDGET_MS) {
      const batch = pending.splice(0, PDFS_PER_CALL);
      const result = writeBatch(sheet, batch, notes);
      added += result;
      props.setProperty('pending', JSON.stringify(pending));
    }

    if (pending.length) {
      // Out of time, not out of work. Come back in a minute and carry on;
      // duplicates are filtered, so overlapping runs are harmless.
      ScriptApp.newTrigger('continueSync').timeBased().after(60 * 1000).create();
      log(sheet, totalPending + ' emails | ' + added + ' trades added | ' +
        pending.length + ' still to read, continuing in a minute');
      return;
    }

    props.setProperty('pending', 'null');
    props.setProperty('firstRunDone', 'yes');

    // Prices, history and tax years are refreshed after the trades land, so
    // they describe the sheet as it now stands. Each is allowed to fail on its
    // own - a price outage must not cost us the trades we just wrote.
    const priced = safely(notes, 'prices', function () { return refreshPrices(sheet); });
    safely(notes, 'history', function () { return writeSnapshot(sheet); });
    safely(notes, 'tax years', function () { return writeTaxYears(sheet); });
    checkEveryScripIsTracked(sheet, notes);

    log(sheet, totalPending + ' emails | ' + added + ' trades added | ' +
      (priced === null ? 'prices unchanged' : priced + ' prices updated') +
      (notes.length ? ' | ' + notes.join(' ; ') : ''));

  } catch (err) {
    log(sheet, 'RUN FAILED: ' + err);
    throw err;
  }
}

/** Run a step, but let the rest of the sync survive it failing. */
function safely(notes, what, fn) {
  try {
    return fn();
  } catch (err) {
    notes.push(what + ' failed: ' + err);
    return null;
  }
}


/* -------------------------------------------------------------- gmail -- */

function findConfirmations(sinceDays) {
  const query = 'from:' + SENDER + ' subject:"' + SUBJECT + '" has:attachment' +
    (sinceDays ? ' newer_than:' + sinceDays + 'd' : '');

  // Paged, because the first run reaches back years and a broker that mails
  // every trading day easily passes a single page.
  const ids = [];
  const page = 100;
  for (let start = 0; start < 2000; start += page) {
    const threads = GmailApp.search(query, start, page);
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (message) { ids.push(message.getId()); });
    });
    if (threads.length < page) break;
  }
  return ids;
}

/** Send one batch of confirmations to the parse service and write what comes back. */
function writeBatch(sheet, messageIds, notes) {
  const pdfs = [];
  messageIds.forEach(function (id) {
    GmailApp.getMessageById(id).getAttachments().forEach(function (att) {
      const name = att.getName() || '';
      if (name.toLowerCase().slice(-4) !== '.pdf') return;
      pdfs.push({
        name: name,
        content_type: att.getContentType(),
        data: Utilities.base64Encode(att.getBytes())
      });
    });
  });
  if (!pdfs.length) return 0;

  const response = post('/parse', {
    broker: BROKER,
    pdfs: pdfs,
    known_rows: knownRows(sheet),
    sectors: sectorMap(sheet)
  });

  (response.problems || []).forEach(function (p) { notes.push(p); });
  if (!response.trades.length) return 0;

  addMissingScrips(sheet, response.trades);
  appendTrades(sheet, response.trades);
  return response.trades.length;
}


/* --------------------------------------------------------------- sheet -- */

function lastDataRow(sheet) {
  // Column A only: the helper formulas in J:P run far below the real data, so
  // getLastRow() would point at empty rows.
  const tab = sheet.getSheetByName(TX);
  const column = tab.getRange(TX_FIRST_ROW, 1, Math.max(tab.getMaxRows() - TX_FIRST_ROW, 1), 1)
    .getValues();
  let last = TX_FIRST_ROW - 1;
  for (let i = 0; i < column.length; i++) {
    if (column[i][0] !== '' && column[i][0] !== null) last = TX_FIRST_ROW + i;
  }
  return last;
}

/** What the sheet already holds, so the service can skip it. */
function knownRows(sheet) {
  const last = lastDataRow(sheet);
  if (last < TX_FIRST_ROW) return [];
  const rows = sheet.getSheetByName(TX)
    .getRange(TX_FIRST_ROW, 1, last - TX_FIRST_ROW + 1, TX_LAST_COL).getValues();
  return rows.map(function (r) { return [r[1], r[3], r[4], r[5], r[8]]; });
}

function sectorMap(sheet) {
  const rows = sheet.getSheetByName(LISTS).getRange('A2:B200').getValues();
  const map = {};
  rows.forEach(function (r) { if (r[0]) map[String(r[0]).trim().toUpperCase()] = r[1]; });
  return map;
}

function appendTrades(sheet, trades) {
  const tab = sheet.getSheetByName(TX);
  const last = lastDataRow(sheet);
  const first = last + 1;

  const values = trades.map(function (t) {
    return [t.date, t.scrip, t.sector, t.type, t.qty, t.rate,
            t.debit || '', t.credit || '', t.notes];
  });
  tab.getRange(first, 1, values.length, TX_LAST_COL).setValues(values);

  // J:P are formulas that depend on row order, so they are dragged down from
  // the row above rather than written. Row 5 always carries the pattern.
  const source = Math.max(last, TX_FIRST_ROW);
  tab.getRange(source, HELPER_FIRST_COL, 1, HELPER_COL_COUNT)
    .copyTo(tab.getRange(first, HELPER_FIRST_COL, values.length, HELPER_COL_COUNT));
}

/**
 * Give any unseen scrip a row in Holdings Summary.
 *
 * The template ships sixty rows whose formulas are already in place and whose
 * name, sector and price are blank, so this only ever writes two cells. No row
 * is inserted and no formula is copied, which is what would risk the charts and
 * the ranges Sector Summary depends on.
 */
function addMissingScrips(sheet, trades) {
  const tab = sheet.getSheetByName(HOLDINGS);
  const totalRow = findTotalRow(tab);
  const slots = totalRow - HOLD_FIRST_ROW;
  const names = tab.getRange(HOLD_FIRST_ROW, 1, slots, 2).getValues();

  const present = {};
  let firstFree = -1;
  names.forEach(function (r, i) {
    const name = String(r[0]).trim().toUpperCase();
    if (name) present[name] = true;
    else if (firstFree === -1) firstFree = HOLD_FIRST_ROW + i;
  });

  const sectors = sectorMap(sheet);
  const seen = {};
  trades.forEach(function (t) {
    const scrip = t.scrip;
    if (present[scrip] || seen[scrip]) return;
    if (firstFree === -1) {
      throw new Error('Holdings Summary is full — add more rows above the TOTAL row');
    }
    tab.getRange(firstFree, 1, 1, 2).setValues([[scrip, sectors[scrip] || '']]);
    present[scrip] = true;
    seen[scrip] = true;
    firstFree = firstFree + 1 < totalRow ? firstFree + 1 : -1;
  });
}

function findTotalRow(tab) {
  const column = tab.getRange(1, 1, tab.getMaxRows(), 1).getValues();
  for (let i = 0; i < column.length; i++) {
    if (String(column[i][0]).trim().toUpperCase() === 'TOTAL') return i + 1;
  }
  throw new Error('Holdings Summary has no TOTAL row');
}

/**
 * A trade recorded but not counted is the worst outcome here: the sheet would
 * quietly under-report and nobody would know. So after writing, every scrip in
 * Transactions must appear in Holdings Summary.
 */
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
  if (missing.length) {
    notes.push('NOT COUNTED in Holdings Summary: ' + missing.join(', '));
  }
}


/* -------------------------------------------------------------- prices -- */

/**
 * Current prices, via the parse service.
 *
 * The first design had this script read the exchange directly, so that each
 * person pulled their own market data and no one service was redistributing
 * it. Apps Script cannot reach the site at all - UrlFetchApp answers
 * "Address unavailable" from Google's network - so the request goes through
 * the service, which can. The service only proxies the same public page
 * anyone can open, caches it briefly, and stores nothing.
 */
function fetchPrices() {
  return post('/prices-for', { symbols: neededScrips() }).prices;
}

/** Only the scrips this sheet actually holds, so the reply stays small. */
function neededScrips() {
  const tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOLDINGS);
  const slots = findTotalRow(tab) - HOLD_FIRST_ROW;
  const names = [];
  tab.getRange(HOLD_FIRST_ROW, 1, slots, 1).getValues().forEach(function (r) {
    const scrip = String(r[0]).trim().toUpperCase();
    if (scrip) names.push(scrip);
  });
  return names;
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
    if (scrip && prices[scrip] !== undefined) {
      column[i][0] = prices[scrip];
      updated++;
    }
  }
  tab.getRange(HOLD_FIRST_ROW, PRICE_COL, slots, 1).setValues(column);
  return updated;
}


/* ------------------------------------------------------ history & tax -- */

/** One row a day, so the portfolio can be seen over time and not just today. */
function writeSnapshot(sheet) {
  const tab = sheet.getSheetByName(HISTORY);
  const holdings = sheet.getSheetByName(HOLDINGS);
  const total = findTotalRow(holdings);
  const t = holdings.getRange(total, 1, 1, 24).getValues()[0];

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
      tab.getRange(i + 2, 1, 1, row.length).setValues([row]);   // same day, replace
      return 'updated';
    }
  }
  tab.getRange(Math.max(tab.getLastRow() + 1, 2), 1, 1, row.length).setValues([row]);
  return 'added';
}

/** Realised profit per tax year, calculated by the service so there is one FIFO. */
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

/** One line per run, in its own tab — never inside the data. */
function log(sheet, message) {
  const tab = sheet.getSheetByName(RUN_LOG);
  if (!tab) return;
  tab.appendRow([
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    message
  ]);
}
