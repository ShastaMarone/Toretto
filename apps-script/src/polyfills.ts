// Newer JavaScript methods, for Apps Script runtimes that don't have them.
// The build lowers newer syntax, but not built-in methods, and Google doesn't
// say which JavaScript version Apps Script runs. Tested with these removed
// (test/jobs.test.ts).

function define(target: object, name: string, value: unknown): void {
  if (!(name in target)) {
    Object.defineProperty(target, name, { value, writable: true, configurable: true });
  }
}

function at(this: ArrayLike<unknown>, index: number): unknown {
  const n = Math.trunc(index) || 0;
  const i = n < 0 ? this.length + n : n;
  return i >= 0 && i < this.length ? this[i] : undefined;
}

define(Array.prototype, 'at', at);
define(String.prototype, 'at', at);

define(
  String.prototype,
  'replaceAll',
  function (this: string, search: string | RegExp, replacement: string) {
    if (search instanceof RegExp) {
      if (!search.global) throw new TypeError('replaceAll needs a global regular expression');
      return this.replace(search, replacement);
    }
    const pattern = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    return this.replace(pattern, replacement);
  },
);

define(Object, 'hasOwn', (object: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(object, key),
);

type Predicate = (value: unknown, index: number, array: unknown[]) => unknown;

define(Array.prototype, 'findLastIndex', function (this: unknown[], predicate: Predicate) {
  for (let i = this.length - 1; i >= 0; i--) if (predicate(this[i], i, this)) return i;
  return -1;
});

define(Array.prototype, 'findLast', function (this: unknown[], predicate: Predicate) {
  for (let i = this.length - 1; i >= 0; i--) if (predicate(this[i], i, this)) return this[i];
  return undefined;
});
