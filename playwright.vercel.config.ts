import { e2eConfig } from './playwright.config';

// The same test against the Vercel build output (`npm run test:e2e:vercel`
// builds first), served by e2e/vercel-local.mjs the way Vercel routes it.
export default e2eConfig('node e2e/vercel-local.mjs', { VERCEL: '1' });
