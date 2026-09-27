export const PALETTE = [
  '#4f46e5',
  '#2563eb',
  '#0891b2',
  '#0d9488',
  '#16a34a',
  '#65a30d',
  '#ca8a04',
  '#ea580c',
  '#dc2626',
  '#db2777',
  '#c026d3',
  '#7c3aed',
  '#475569',
];

/** Hex color with an alpha suffix, e.g. for soft backgrounds. */
export function alpha(hex: string, amount: number): string {
  const a = Math.round(Math.min(1, Math.max(0, amount)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? [parts[0]![0], parts[parts.length - 1]![0]] : [parts[0]?.[0], parts[0]?.[1]];
  return letters.filter(Boolean).join('').toUpperCase();
}

export function colorFor(key: string): string {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}
