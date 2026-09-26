import { Toaster } from 'sonner';
import { useTheme } from '../lib/theme';

/** Toasts that follow the light / dark theme. */
export function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster position="top-center" richColors closeButton theme={resolved} />;
}
