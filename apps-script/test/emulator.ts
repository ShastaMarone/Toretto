// An in-memory stand-in for the Apps Script services the code uses, strict
// where the real ones are: ranges must fit the sheet, cells hold at most
// 50,000 characters, and text starting with "=" would become a formula.
import { randomUUID } from 'node:crypto';

type Cell = string | number | boolean | Date;

export class FakeRange {
  constructor(
    private readonly sheet: FakeSheet,
    private readonly row: number,
    private readonly col: number,
    private readonly rows: number,
    private readonly cols: number,
  ) {
    if (row < 1 || col < 1 || rows < 1 || cols < 1) throw new Error('Invalid range');
    if (row + rows - 1 > sheet.maxRows || col + cols - 1 > sheet.maxCols) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
  }

  getValues(): Cell[][] {
    return Array.from({ length: this.rows }, (_, r) =>
      Array.from({ length: this.cols }, (_, c) => this.sheet.cell(this.row + r, this.col + c)),
    );
  }

  setValues(values: unknown[][]): FakeRange {
    if (values.length !== this.rows || values.some((v) => v.length !== this.cols)) {
      throw new Error(
        `The number of rows or columns in the data does not match the range (${this.rows}×${this.cols})`,
      );
    }
    values.forEach((row, r) =>
      row.forEach((value, c) => this.sheet.set(this.row + r, this.col + c, value as Cell)),
    );
    this.sheet.book.writes++;
    return this;
  }

  clearContent(): FakeRange {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) this.sheet.set(this.row + r, this.col + c, '');
    }
    this.sheet.book.writes++;
    return this;
  }

  setNumberFormat(format: string): FakeRange {
    if (format !== '@') throw new Error(`Only plain text is used, not ${format}`);
    return this;
  }

  setFontWeight(_weight: string): FakeRange {
    return this;
  }
}

export class FakeSheet {
  readonly cells = new Map<string, Cell>();
  maxRows = 1000;
  maxCols = 26;

  constructor(
    readonly book: FakeSpreadsheet,
    readonly name: string,
  ) {}

  cell(row: number, col: number): Cell {
    return this.cells.get(`${row}:${col}`) ?? '';
  }

  set(row: number, col: number, value: Cell): void {
    if (typeof value === 'string' && value.length > 50_000) {
      throw new Error(
        'Your input contains more than the maximum of 50000 characters in a single cell.',
      );
    }
    if (typeof value === 'string' && value.startsWith('=')) {
      throw new Error(`Would be read as a formula: ${value.slice(0, 40)}`);
    }
    if (value === '' || value === null || value === undefined) this.cells.delete(`${row}:${col}`);
    else this.cells.set(`${row}:${col}`, value);
  }

  private extent(): { rows: number; cols: number } {
    let rows = 0;
    let cols = 0;
    for (const key of this.cells.keys()) {
      const [r, c] = key.split(':').map(Number) as [number, number];
      rows = Math.max(rows, r);
      cols = Math.max(cols, c);
    }
    return { rows, cols };
  }

  getDataRange(): FakeRange {
    const { rows, cols } = this.extent();
    return new FakeRange(this, 1, 1, Math.max(rows, 1), Math.max(cols, 1));
  }

  getRange(row: number, col: number, rows = 1, cols = 1): FakeRange {
    return new FakeRange(this, row, col, rows, cols);
  }

  getLastColumn(): number {
    return this.extent().cols;
  }

  getLastRow(): number {
    return this.extent().rows;
  }

  getMaxRows(): number {
    return this.maxRows;
  }

  getMaxColumns(): number {
    return this.maxCols;
  }

  insertRowsAfter(after: number, count: number): FakeSheet {
    if (after !== this.maxRows) throw new Error('Only appending rows is emulated');
    this.maxRows += count;
    return this;
  }

  insertColumnsAfter(after: number, count: number): FakeSheet {
    if (after !== this.maxCols) throw new Error('Only appending columns is emulated');
    this.maxCols += count;
    return this;
  }

  setFrozenRows(_rows: number): FakeSheet {
    return this;
  }

  /** The rows as objects keyed by the header, for tests. */
  records(): Record<string, string>[] {
    const values = this.getDataRange().getValues();
    const header = values[0]!.map(String);
    return values
      .slice(1)
      .filter((row) => row.some((v) => v !== ''))
      .map((row) => Object.fromEntries(header.map((h, i) => [h, String(row[i] ?? '')])));
  }
}

export class FakeSpreadsheet {
  readonly sheets = new Map<string, FakeSheet>();
  /** setValues/clearContent calls, to keep an eye on how chatty a request is. */
  writes = 0;

  constructor(readonly id: string) {}

  getId(): string {
    return this.id;
  }

  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name: string): FakeSheet {
    if (this.sheets.has(name)) throw new Error(`A sheet named ${name} already exists`);
    const sheet = new FakeSheet(this, name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

export interface SentEmail {
  to: string;
  subject: string;
  body: string;
  htmlBody?: string;
  name?: string;
}

/** Everything a test can see and steer. */
export interface Emulator {
  book: FakeSpreadsheet;
  properties: Map<string, string>;
  /** The Google account using the app right now ('' for none). */
  activeUser: string;
  owner: string;
  sent: SentEmail[];
  /** Make MailApp fail for these addresses. */
  failFor: Set<string>;
  quota: number;
  triggers: { handler: string; every: string }[];
  /** Pretend the script lock is held by someone else. */
  lockBusy: boolean;
  appUrl: string;
  /** Responses that queued emails (the page then asks for them to be sent). */
  kicks: number;
  /** The project's HTML files (index: a stand-in page unless set). */
  files: Map<string, string>;
}

let active: Emulator | null = null;
const env = (): Emulator => {
  if (!active) throw new Error('No emulated Apps Script project is active');
  return active;
};

/** A fresh project: its own Sheet, properties, sent mail and triggers. */
export function createEmulator(): Emulator {
  return {
    book: new FakeSpreadsheet('test-sheet'),
    properties: new Map(),
    activeUser: '',
    owner: 'owner@example.com',
    sent: [],
    failFor: new Set(),
    quota: 1500,
    triggers: [],
    lockBusy: false,
    appUrl: 'https://script.google.com/macros/s/TEST/exec',
    kicks: 0,
    files: new Map([
      ['index', '<html><body><div id="root"></div><!--TORETTO_BOOT--></body></html>'],
    ]),
  };
}

/** Make the Apps Script services act on this project (tests can have several). */
export function activate(emulator: Emulator): void {
  active = emulator;
}

function htmlOutput(html: string) {
  const output = {
    title: '',
    meta: {} as Record<string, string>,
    getContent: () => html,
    setTitle(title: string) {
      output.title = title;
      return output;
    },
    addMetaTag(name: string, content: string) {
      output.meta[name] = content;
      return output;
    },
    setXFrameOptionsMode() {
      return output;
    },
  };
  return output;
}

/** Install the Apps Script globals (on globalThis, or on a vm context's global). */
export function installAppsScript(target: Record<string, unknown> = globalThis as never): void {
  const created = new Map<string, FakeSpreadsheet>();
  Object.assign(target, {
    SpreadsheetApp: {
      openById: (id: string) => {
        const book = id === env().book.id ? env().book : created.get(id);
        if (!book) throw new Error(`No spreadsheet ${id}`);
        return book;
      },
      getActiveSpreadsheet: () => env().book,
      create: (name: string) => {
        const book = new FakeSpreadsheet(`created-${name}`);
        created.set(book.id, book);
        return book;
      },
      flush: () => undefined,
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) => env().properties.get(key) ?? null,
        setProperty: (key: string, value: string) => {
          env().properties.set(key, value);
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => !env().lockBusy,
        waitLock: () => {
          if (env().lockBusy) throw new Error('Lock timeout');
        },
        releaseLock: () => undefined,
      }),
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => env().activeUser }),
      getEffectiveUser: () => ({ getEmail: () => env().owner }),
      getScriptTimeZone: () => 'America/Toronto',
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => env().appUrl }),
      getProjectTriggers: () =>
        env().triggers.map((t) => ({ getHandlerFunction: () => t.handler, trigger: t })),
      deleteTrigger: (trigger: { trigger: { handler: string } }) => {
        env().triggers = env().triggers.filter((t) => t !== trigger.trigger);
      },
      newTrigger: (handler: string) => {
        let every = '';
        const builder = {
          timeBased: () => builder,
          everyMinutes: (n: number) => ((every = `${n} minutes`), builder),
          everyHours: (n: number) => ((every = `${n} hours`), builder),
          create: () => env().triggers.push({ handler, every }),
        };
        return builder;
      },
    },
    MailApp: {
      getRemainingDailyQuota: () => env().quota,
      sendEmail: (message: SentEmail) => {
        const e = env();
        if (e.failFor.has(message.to)) throw new Error('Service invoked too many times');
        if (e.quota <= 0) throw new Error('Quota exceeded');
        e.quota--;
        e.sent.push(message);
      },
    },
    Utilities: { getUuid: () => randomUUID() },
    HtmlService: {
      createHtmlOutputFromFile: (name: string) => {
        const html = env().files.get(name);
        if (html === undefined) throw new Error(`No HTML file ${name}`);
        return htmlOutput(html);
      },
      createHtmlOutput: htmlOutput,
      XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
    },
  });
}
