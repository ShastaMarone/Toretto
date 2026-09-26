// Tiny auto-escaping HTML templating for emails. Every interpolated value is
// escaped unless it is itself produced by `html` (or explicitly `raw`).

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** Trusted markup only (never user input). */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/** Only allow validated hex colors into inline styles. */
export function safeColor(color: string | null | undefined, fallback = '#64748b'): string {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}
