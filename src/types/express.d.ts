import type { PublicUser } from '../repositories/users.repository.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware when the session cookie is valid. */
      user?: PublicUser;
      sessionTokenHash?: string;
    }
  }
}

export {};
