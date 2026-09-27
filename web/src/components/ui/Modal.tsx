import { X } from 'lucide-react';
import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Button } from './Button';

const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' };

/**
 * A modal built on <dialog>, so focus trapping, Escape and screen-reader
 * semantics come from the browser. Mount it to open; unmount to close.
 * On phones it slides up as a bottom sheet.
 */
export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  onSubmit,
  size = 'md',
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  size?: keyof typeof widths;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    // Usually the button that opened it.
    const opener = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      // React has already taken the dialog off the page, so the browser can't
      // hand focus back by itself.
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);

  const body = (
    <>
      <div className="overflow-y-auto px-5 py-4">{children}</div>
      {footer && (
        <div className="flex flex-wrap-reverse justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3 sm:rounded-b-2xl">
          {footer}
        </div>
      )}
    </>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // React hands a dialog opened inside this one its Escape too; leave that to it.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={cx(
        'mx-auto mt-auto mb-0 max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-2xl bg-surface/90 p-0 text-slate-900 shadow-2xl ring-1 ring-slate-200/70 backdrop-blur-xl sm:my-auto sm:w-[calc(100%-2rem)] sm:rounded-2xl dark:shadow-[0_30px_80px_-20px_var(--glow)]',
        widths[size],
      )}
    >
      <div className="flex max-h-[92dvh] flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-slate-900">
              {title}
            </h2>
            {description && <div className="mt-0.5 text-sm text-slate-500">{description}</div>}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={onClose}
            className="-mr-2 -mt-1"
          >
            <X className="size-4" />
          </Button>
        </div>
        {onSubmit ? (
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(e);
            }}
          >
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  danger = false,
  loading = false,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-slate-600">{children}</div>
    </Modal>
  );
}
