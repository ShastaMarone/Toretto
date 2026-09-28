import type { ColumnType, TableDef } from './schema';
import { TABLES } from './schema';

type Sheet = GoogleAppsScript.Spreadsheet.Sheet;
type Spreadsheet = GoogleAppsScript.Spreadsheet.Spreadsheet;

/** Where the data lives: set by setup() (the Sheet this script is attached to, or a new one). */
export const SPREADSHEET_ID = 'SPREADSHEET_ID';

// Sheets reads text starting with these as a formula, so such text is stored
// behind an invisible zero-width space (and read back without it).
const ESCAPE = '​';
const FORMULA_START = /^[=+\-@']/;
/** Sheets refuses longer cells. */
export const MAX_CELL = 50_000;

/** publishedStartTime → published_start_time: the Sheet's column names match the Postgres ones. */
export const columnName = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function toCell(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined) return '';
  if (type === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (type === 'number') return String(value);
  if (type === 'json') return JSON.stringify(value);
  const text = String(value);
  return FORMULA_START.test(text) || text.startsWith(ESCAPE) ? ESCAPE + text : text;
}

export function fromCell(cell: unknown, type: ColumnType): unknown {
  if (cell === '' || cell === null || cell === undefined) return null;
  // Someone typed into the Sheet and Sheets turned it into a date or number.
  if (cell instanceof Date) return cell.toISOString();
  const text = String(cell);
  switch (type) {
    case 'boolean':
      return text === 'TRUE' || text === 'true' || text === '1';
    case 'number': {
      const n = Number(text);
      return Number.isFinite(n) ? n : null;
    }
    case 'json':
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    default:
      return text.startsWith(ESCAPE) ? text.slice(1) : text;
  }
}

type Patch<T> = Partial<Omit<T, 'id'>>;

/**
 * One tab, read once per request and written back on commit. Rows are plain
 * objects: change them only through update(), so the change is saved.
 */
export class Table<T extends { id: string }> {
  private loaded = false;
  private header: string[] = [];
  /** Index i is Sheet row i + 2; null for a blank (deleted) row. */
  private rows: (T | null)[] = [];
  /** The cells as read, so columns this code doesn't know about survive a rewrite. */
  private raw: unknown[][] = [];
  private byId = new Map<string, number>();
  private changed = new Set<number>();
  /** Data rows in the Sheet when it was read. */
  private readCount = 0;
  private readonly fields: (keyof T & string)[];

  constructor(
    private readonly db: Db,
    readonly def: TableDef<T>,
  ) {
    this.fields = Object.keys(def.columns) as (keyof T & string)[];
  }

  private load(): void {
    if (this.loaded) return;
    const values = this.db.sheet(this.def.name).getDataRange().getValues();
    this.header = (values[0] ?? []).map(String);
    const at = new Map(this.header.map((name, i) => [name, i]));
    this.rows = [];
    this.raw = [];
    this.byId.clear();
    for (let r = 1; r < values.length; r++) {
      const cells = values[r]!;
      const idAt = at.get('id');
      const id = idAt === undefined ? '' : String(cells[idAt] ?? '');
      this.raw.push(cells);
      if (!id) {
        this.rows.push(null);
        continue;
      }
      const row = {} as Record<string, unknown>;
      for (const field of this.fields) {
        const i = at.get(columnName(field));
        const type = this.def.columns[field];
        const value = i === undefined ? null : fromCell(cells[i], type);
        row[field] = value ?? this.fallback(field);
      }
      this.byId.set(id, this.rows.length);
      this.rows.push(row as T);
    }
    this.readCount = this.rows.length;
    this.loaded = true;
  }

  /** What an empty cell means: the default, else [] for lists and null otherwise. */
  private fallback(field: keyof T & string): unknown {
    const value = this.def.defaults?.[field];
    if (value !== undefined) return Array.isArray(value) ? [...value] : value;
    if (this.def.columns[field] === 'boolean') return false;
    return null;
  }

  all(): T[] {
    this.load();
    return this.rows.filter((row): row is T => row !== null);
  }

  where(test: (row: T) => boolean): T[] {
    return this.all().filter(test);
  }

  find(test: (row: T) => boolean): T | undefined {
    return this.all().find(test);
  }

  get(id: string | null | undefined): T | undefined {
    if (!id) return undefined;
    this.load();
    const i = this.byId.get(id);
    return i === undefined ? undefined : (this.rows[i] ?? undefined);
  }

  insert(values: Partial<T> & { id?: string }): T {
    this.load();
    const now = this.db.now;
    const row = {} as Record<string, unknown>;
    for (const field of this.fields) row[field] = this.fallback(field);
    if ('createdAt' in this.def.columns) row.createdAt = now;
    if ('updatedAt' in this.def.columns) row.updatedAt = now;
    Object.assign(row, values);
    row.id ??= Utilities.getUuid();
    const i = this.rows.length;
    this.rows.push(row as T);
    this.raw.push([]);
    this.byId.set(row.id as string, i);
    this.changed.add(i);
    return row as T;
  }

  update(id: string, patch: Patch<T>): T {
    this.load();
    const i = this.byId.get(id);
    const row = i === undefined ? null : this.rows[i];
    if (i === undefined || !row) throw new Error(`${this.def.name}: no row ${id}`);
    Object.assign(row, patch);
    if ('updatedAt' in this.def.columns && !('updatedAt' in patch)) {
      (row as Record<string, unknown>).updatedAt = this.db.now;
    }
    this.changed.add(i);
    return row;
  }

  delete(id: string): void {
    this.load();
    const i = this.byId.get(id);
    if (i === undefined) return;
    this.rows[i] = null;
    this.byId.delete(id);
    this.changed.add(i);
  }

  /** Blank rows left by deletions, which compact() reclaims. */
  blankRows(): number {
    this.load();
    return this.rows.filter((row) => row === null).length;
  }

  private cells(i: number): unknown[] {
    const row = this.rows[i];
    const out = this.header.map((_, c) => (row === null ? '' : (this.raw[i]?.[c] ?? '')));
    if (!row) return out;
    for (const field of this.fields) {
      const c = this.header.indexOf(columnName(field));
      if (c >= 0) out[c] = toCell((row as Record<string, unknown>)[field], this.def.columns[field]);
    }
    return out;
  }

  /** Write the changes: few, large Sheet calls (a call costs more than its size). */
  commit(): void {
    if (!this.loaded || this.changed.size === 0) {
      this.loaded = false;
      return;
    }
    const sheet = this.db.sheet(this.def.name);
    // Rows added and deleted in the same request are never written.
    const indexes = [...this.changed]
      .filter((i) => i < this.readCount || this.rows[i] !== null)
      .sort((a, b) => a - b);
    const added = indexes.filter((i) => i >= this.readCount);
    const existing = indexes.filter((i) => i < this.readCount);
    const blocks: { start: number; rows: unknown[][] }[] = [];
    const runs: number[][] = [];
    for (const i of existing) {
      const run = runs.at(-1);
      if (run && run.at(-1)! + 1 === i) run.push(i);
      else runs.push([i]);
    }
    if (runs.length > 8) {
      // Scattered edits: one call over the span beats many small ones.
      const first = existing[0]!;
      const last = existing.at(-1)!;
      const span: unknown[][] = [];
      for (let i = first; i <= last; i++) span.push(this.cells(i));
      blocks.push({ start: first, rows: span });
    } else {
      for (const run of runs) blocks.push({ start: run[0]!, rows: run.map((i) => this.cells(i)) });
    }
    if (added.length) {
      blocks.push({ start: this.readCount, rows: added.map((i) => this.cells(i)) });
    }
    const lastRow = Math.max(...blocks.map((b) => b.start + b.rows.length)) + 1;
    if (sheet.getMaxRows() < lastRow) {
      sheet.insertRowsAfter(sheet.getMaxRows(), lastRow - sheet.getMaxRows());
    }
    for (const block of blocks) {
      sheet
        .getRange(block.start + 2, 1, block.rows.length, this.header.length)
        .setNumberFormat('@')
        .setValues(block.rows);
    }
    this.changed.clear();
    this.loaded = false;
  }

  /** Rewrite the rows without the blanks deletions left behind. */
  compact(): number {
    this.load();
    const blanks = this.blankRows();
    if (!blanks || this.changed.size) return 0;
    const sheet = this.db.sheet(this.def.name);
    const live = this.rows.map((row, i) => (row ? i : -1)).filter((i) => i >= 0);
    const values = live.map((i) => this.cells(i));
    if (values.length) {
      sheet
        .getRange(2, 1, values.length, this.header.length)
        .setNumberFormat('@')
        .setValues(values);
    }
    sheet.getRange(values.length + 2, 1, blanks, this.header.length).clearContent();
    this.loaded = false;
    return blanks;
  }
}

/** The Sheet, opened once per request. `now` is the request's single clock reading. */
export class Db {
  readonly now: string;
  private book: Spreadsheet | null = null;
  private readonly tables = new Map<string, Table<{ id: string }>>();
  private readonly sheets = new Map<string, Sheet>();

  constructor(now = new Date()) {
    this.now = now.toISOString();
  }

  spreadsheet(): Spreadsheet {
    if (!this.book) {
      const id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID);
      if (!id) throw new Error('Not set up yet: run setup() in the Apps Script editor first');
      this.book = SpreadsheetApp.openById(id);
    }
    return this.book;
  }

  sheet(name: string): Sheet {
    let sheet = this.sheets.get(name);
    if (!sheet) {
      sheet = this.spreadsheet().getSheetByName(name) ?? undefined;
      if (!sheet) throw new Error(`The Sheet has no "${name}" tab: run setup() again`);
      this.sheets.set(name, sheet);
    }
    return sheet;
  }

  table<T extends { id: string }>(def: TableDef<T>): Table<T> {
    let table = this.tables.get(def.name);
    if (!table) {
      table = new Table(this, def) as unknown as Table<{ id: string }>;
      this.tables.set(def.name, table);
    }
    return table as unknown as Table<T>;
  }

  /** Save every change made through this Db. */
  commit(): void {
    for (const table of this.tables.values()) table.commit();
    SpreadsheetApp.flush();
  }
}

/**
 * Create any missing tabs and columns (new versions add columns at the end),
 * with every cell formatted as plain text. Returns what it changed.
 */
export function ensureSchema(book: Spreadsheet): string[] {
  const changes: string[] = [];
  for (const def of TABLES) {
    const names = Object.keys(def.columns).map(columnName);
    let sheet = book.getSheetByName(def.name);
    if (!sheet) {
      sheet = book.insertSheet(def.name);
      changes.push(`Added the ${def.name} tab`);
    }
    const width = Math.max(sheet.getLastColumn(), 1);
    const header = sheet
      .getRange(1, 1, 1, width)
      .getValues()[0]!
      .map(String)
      .filter((name) => name !== '');
    const missing = names.filter((name) => !header.includes(name));
    if (missing.length) {
      const start = header.length + 1;
      const needed = start + missing.length - 1;
      if (sheet.getMaxColumns() < needed) {
        sheet.insertColumnsAfter(sheet.getMaxColumns(), needed - sheet.getMaxColumns());
      }
      sheet
        .getRange(1, start, 1, missing.length)
        .setNumberFormat('@')
        .setValues([missing])
        .setFontWeight('bold');
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, sheet.getMaxRows(), needed).setNumberFormat('@');
      if (header.length) changes.push(`Added ${missing.join(', ')} to ${def.name}`);
    }
  }
  return changes;
}
