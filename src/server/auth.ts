/**
 * The single local user, and signed media links.
 *
 * TripAlogue runs on one computer for one person: there is no sign-in. The server listens on this computer only
 * (127.0.0.1) and every request acts as the local user, created on first start. Mutating requests still need the
 * X-TripAlogue-Client header (see app.ts) and the Host header must name this computer, so other web pages open in
 * the same browser cannot drive the app.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import type { ServerConfig } from './config.js';
import type { Db } from './db.js';

export interface User {
  id: string;
  email: string;
  name: string;
}

/** The local user's stored address: never used to send anything, it only keys the users table. */
export const LOCAL_EMAIL = 'me@this-computer';

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;

function localName(): string {
  try {
    const n = os.userInfo().username;
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Me';
  } catch {
    return 'Me';
  }
}

export class Auth {
  /** The person using this computer: every request acts as them. */
  readonly user: User;

  constructor(private readonly db: Db, private readonly cfg: ServerConfig) {
    this.user = this.upsertUser(LOCAL_EMAIL, localName());
    // Projects made before the app went single-user (or by another account in the same data folder) belong to the
    // local user too.
    this.db.run(`INSERT INTO members (project_id, user_id, role, invited_by, joined_at)
      SELECT p.id, ?, 'owner', NULL, ? FROM projects p WHERE NOT EXISTS (SELECT 1 FROM members m WHERE m.project_id = p.id AND m.user_id = ?)`,
    this.user.id, Date.now(), this.user.id);
  }

  upsertUser(email: string, name?: string): User {
    const existing = this.db.get<User>('SELECT id, email, name FROM users WHERE email = ?', email);
    if (existing) return existing;
    const user = { id: newId('usr'), email, name: name ?? email.split('@')[0] };
    this.db.run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', user.id, user.email, user.name, Date.now());
    return user;
  }

  // ---- Signed, short-lived media links ----

  private sign(v: string): string {
    return createHmac('sha256', this.cfg.secret).update(v).digest('base64url');
  }

  /**
   * A media link. It lasts a day: a video element keeps the link it was redirected to and asks it for more of the
   * file as it plays, so a short life broke long editing sessions (the app answers only on this computer).
   */
  signBlobUrl(key: string, ttlSec = 24 * 3600): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `/blob/${key}?exp=${exp}&sig=${this.sign(`${key}:${exp}`)}`;
  }

  verifyBlob(key: string, exp: string | null, sig: string | null): boolean {
    if (!exp || !sig || Number(exp) * 1000 < Date.now()) return false;
    const want = this.sign(`${key}:${exp}`);
    return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  }
}
