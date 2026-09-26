import type { AuthUser } from './auth/types';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** Hashed id of the current session, when signed in. */
      sessionId?: string;
    }
  }
}

export {};
