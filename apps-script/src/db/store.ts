import { HttpError } from '../../../server/src/errors';
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
    const values = this.db.readValues(this.def.name);
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

  /** Changes waiting to be written. */
  hasChanges(): boolean {
    return this.loaded && this.changed.size > 0;
  }

  /**
   * Read from the cache, but the Sheet now has more or fewer rows than that
   * copy: someone edited it by hand. Writing now could overwrite their rows.
   */
  isStale(): boolean {
    return (
      this.loaded &&
      this.db.servedFromCache(this.def.name) &&
      this.db.sheet(this.def.name).getLastRow() !== this.readCount + 1
    );
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

  /** Write the changes: few, large Sheet calls (a call costs more than its size). True if anything was written. */
  commit(): boolean {
    if (!this.loaded || this.changed.size === 0) {
      this.loaded = false;
      return false;
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
    return true;
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
    this.db.invalidateCache();
    return blanks;
  }
}

// ---- A cache of what's in the Sheet ----------------------------------------
// Reading a tab from the Sheet takes a good fraction of a second; reading it
// from CacheService takes a few hundredths. Pages only read, so reads
// (Db.reader()) use the cache. Anything that changes the Sheet reads the Sheet
// itself, and changes the cache's generation, which every cached tab is filed
// under, so the old copies are never used again. Never required: if the cache
// misbehaves, the Sheet is read instead.

/** Big and rarely read by the pages (or holding whole emails): always from the Sheet. */
const UNCACHED = new Set(['email_log', 'audit_log']);
/** Script property: {"*": a generation for everything, "<tab>": a newer one for just that tab}. */
const GENERATIONS = 'CACHE_GENERATIONS';
type Generations = Record<string, string>;

function parseGenerations(text: string | null): Generations | null {
  try {
    const value = text ? (JSON.parse(text) as unknown) : null;
    return value && typeof value === 'object' && typeof (value as Generations)['*'] === 'string'
      ? (value as Generations)
      : null;
  } catch {
    return null;
  }
}

const newGeneration = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const CACHE_SECONDS = 6 * 60 * 60;
/** A cache value may be 100 KB (in bytes: leave room for accented letters). */
const CHUNK = 30_000;

function tryCache<T>(fn: (cache: GoogleAppsScript.Cache.Cache) => T): T | null {
  try {
    return fn(CacheService.getScriptCache());
  } catch {
    return null;
  }
}

/** A cached copy was out of date: nothing was written; run again reading the Sheet. */
export class StaleCacheError extends Error {
  constructor() {
    super('The Sheet changed since it was cached');
  }
}

/** The Sheet, opened once per request. `now` is the request's single clock reading. */
export class Db {
  readonly now: string;
  private generations: Generations | null = null;
  private readonly fromCache = new Set<string>();
  private book: Spreadsheet | null = null;
  private readonly tables = new Map<string, Table<{ id: string }>>();
  private readonly sheets = new Map<string, Sheet>();

  constructor(
    now = new Date(),
    /** Read tabs from the cache when it has them: for requests that only read. */
    private readonly cached = false,
  ) {
    this.now = now.toISOString();
  }

  /** A Db for requests that only read. */
  static reader(): Db {
    return new Db(new Date(), true);
  }

  /**
   * A Db for requests that change things; they read the cache too. They hold
   * the lock, and every save changes the generations of the tabs it wrote, so
   * the copies are current. commit() checks the Sheet wasn't edited by hand.
   */
  static writer(): Db {
    return new Db(new Date(), true);
  }

  /**
   * The generations cached copies are filed under. They live in script
   * properties, not the cache, so a change can't be forgotten if the cache is
   * down just then.
   */
  private currentGenerations(): Generations | null {
    if (this.generations) return this.generations;
    try {
      const props = PropertiesService.getScriptProperties();
      let gens = parseGenerations(props.getProperty(GENERATIONS));
      if (!gens) {
        gens = { '*': newGeneration() };
        props.setProperty(GENERATIONS, JSON.stringify(gens));
      }
      this.generations = gens;
    } catch {
      this.generations = null;
    }
    return this.generations;
  }

  /** Everything cached is out of date: the Sheet changed in ways we can't pin to tabs. */
  invalidateCache(): void {
    this.setGenerations({ '*': newGeneration() });
  }

  /** These tabs were written: only their cached copies are out of date. */
  invalidateTabs(names: string[]): void {
    if (!names.length) return;
    let gens: Generations | null = null;
    try {
      gens = parseGenerations(PropertiesService.getScriptProperties().getProperty(GENERATIONS));
    } catch {
      // start over below
    }
    gens ??= { '*': newGeneration() };
    for (const name of names) gens[name] = newGeneration();
    this.setGenerations(gens);
  }

  private setGenerations(gens: Generations): void {
    this.generations = null;
    try {
      PropertiesService.getScriptProperties().setProperty(GENERATIONS, JSON.stringify(gens));
    } catch (err) {
      // Without this, old copies could be used: don't let the cache be used at all.
      console.error(`Couldn't mark the cache out of date: ${String(err)}`);
      throw err;
    }
  }

  /** Whether this tab's cells came from the cache rather than the Sheet. */
  servedFromCache(name: string): boolean {
    return this.fromCache.has(name);
  }

  /** A tab's cells: from the cache if this Db may and it has them, else from the Sheet. */
  readValues(name: string): unknown[][] {
    const useCache = this.cached && !UNCACHED.has(name);
    const gens = useCache ? this.currentGenerations() : null;
    const gen = gens ? `${gens['*']}.${gens[name] ?? ''}` : null;
    const key = `toretto:${name}:${gen}`;
    if (gen) {
      const hit = tryCache((cache) => {
        const first = cache.get(`${key}:0`);
        if (first === null) return null;
        const bar = first.indexOf('|');
        const count = Number(first.slice(0, bar));
        const parts = [first.slice(bar + 1)];
        if (count > 1) {
          const rest = cache.getAll(Array.from({ length: count - 1 }, (_, i) => `${key}:${i + 1}`));
          for (let i = 1; i < count; i++) {
            const part = rest[`${key}:${i}`];
            if (part === undefined) return null;
            parts.push(part);
          }
        }
        return JSON.parse(parts.join('')) as unknown[][];
      });
      if (hit) {
        this.fromCache.add(name);
        return hit;
      }
    }
    const values = this.sheet(name).getDataRange().getValues();
    if (gen) {
      tryCache((cache) => {
        const json = JSON.stringify(values);
        const count = Math.max(1, Math.ceil(json.length / CHUNK));
        const items: Record<string, string> = {};
        for (let i = 0; i < count; i++) {
          items[`${key}:${i}`] =
            `${i === 0 ? `${count}|` : ''}${json.slice(i * CHUNK, (i + 1) * CHUNK)}`;
        }
        cache.putAll(items, CACHE_SECONDS);
      });
    }
    return values;
  }

  spreadsheet(): Spreadsheet {
    if (!this.book) {
      const id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID);
      if (!id) {
        throw new HttpError(
          503,
          'NOT_SET_UP',
          "This app isn't set up yet. Run setup in the Apps Script editor, then reload this page.",
        );
      }
      this.book = SpreadsheetApp.openById(id);
    }
    return this.book;
  }

  sheet(name: string): Sheet {
    let sheet = this.sheets.get(name);
    if (!sheet) {
      sheet = this.spreadsheet().getSheetByName(name) ?? undefined;
      if (!sheet) {
        throw new HttpError(
          503,
          'NOT_SET_UP',
          `The Sheet is missing its "${name}" tab. Run setup again in the Apps Script editor.`,
        );
      }
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
    // Check before writing anything: a copy from the cache may be out of date.
    for (const table of this.tables.values()) {
      if (table.hasChanges() && table.isStale()) {
        this.invalidateCache();
        throw new StaleCacheError();
      }
    }
    const written: string[] = [];
    for (const table of this.tables.values()) {
      if (table.commit()) written.push(table.def.name);
    }
    if (!written.length) return;
    SpreadsheetApp.flush();
    this.invalidateTabs(written);
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
