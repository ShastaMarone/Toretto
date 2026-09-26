import { createContext, use } from 'react';

/** What a <Field> tells the control inside it: its id, hint/error and validity. */
export interface FieldInfo {
  id: string;
  describedBy?: string;
  invalid: boolean;
}

export const FieldContext = createContext<FieldInfo | null>(null);

/** Look shared by inputs, selects and the pickers. */
export const controlClass =
  'block w-full rounded-lg border-0 bg-surface text-sm text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 transition placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:shadow-[0_0_0_4px_var(--glow-soft)] disabled:bg-slate-50 disabled:text-slate-500';

/** Label and describe a control from the <Field> around it. */
export function useField(id?: string) {
  const field = use(FieldContext);
  return {
    id: id ?? field?.id,
    'aria-describedby': field?.describedBy,
    'aria-invalid': field?.invalid || undefined,
    invalid: field?.invalid ?? false,
  };
}
