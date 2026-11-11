/**
 * Accounts and sessions (F-6).
 *
 * - Email-link sign-in: a single-use token, valid 15 minutes, stored only as a
 *   hash. Requesting a link never reveals whether an account exists.
 * - Google sign-in (OAuth 2.0 authorization code with PKCE), enabled when a
 *   client id and secret are configured.
 * - Sessions: random 256-bit ids in an HttpOnly, SameSite=Lax cookie (Secure
 *   on https), stored hashed, 30 days by default.
 * - No passwords are ever stored.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from './config.js';
import type { Db } from './db.js';
import { HttpError, parseCookies, type Req, type Res } from './http.js';
import type { Mailer } from './mailer.js';

export interface User {
  id: string;
  email: string;
  name: string;
}

export const SESSION_COOKIE = 'tl_session';
const LINK_TTL_MS = 15 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;

/** Only same-site relative paths may be used as post-sign-in destinations. */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?!\/)[\w\-./?=&#%]*$/.test(next) ? next : '/';
}

export class Auth {
  constructor(private readonly db: Db, private readonly cfg: ServerConfig, private readonly mailer: Mailer) {}

  normalizeEmail(email: unknown): string {
    if (typeof email !== 'string' || email.length > 254 || !EMAIL.test(email.trim())) throw new HttpError(400, 'Enter a valid email address', 'invalid_email');
    return email.trim().toLowerCase();
  }

  async requestEmailLink(emailIn: unknown, next?: unknown): Promise<void> {
    const email = this.normalizeEmail(emailIn);
    const t = token();
    this.db.run('INSERT INTO login_tokens (token_hash, email, next_path, expires_at) VALUES (?, ?, ?, ?)', sha256(t), email, safeNext(next), Date.now() + LINK_TTL_MS);
    const link = `${this.cfg.baseUrl}/api/auth/verify?token=${t}`;
    await this.mailer.send({
      to: email,
      subject: 'Your TripAlogue sign-in link',
      text: `Sign in to TripAlogue:\n\n${link}\n\nThis link works once and expires in 15 minutes. If you did not ask for it, ignore this email.`,
    });
  }

  /** Consume a sign-in token; returns the user and where to go next. */
  verifyEmailLink(t: string): { user: User; next: string } {
    return this.db.tx(() => {
      const row = this.db.get<{ email: string; next_path: string; expires_at: number; used_at: number | null }>(
        'SELECT email, next_path, expires_at, used_at FROM login_tokens WHERE token_hash = ?', sha256(t),
      );
      if (!row || row.used_at !== null || row.expires_at < Date.now()) throw new HttpError(400, 'This sign-in link is invalid or has expired. Request a new one.', 'bad_token');
      this.db.run('UPDATE login_tokens SET used_at = ? WHERE token_hash = ?', Date.now(), sha256(t));
      return { user: this.upsertUser(row.email), next: row.next_path || '/' };
    });
  }

  upsertUser(email: string, name?: string): User {
    const existing = this.db.get<User>('SELECT id, email, name FROM users WHERE email = ?', email);
    if (existing) return existing;
    const user = { id: newId('usr'), email, name: name ?? email.split('@')[0] };
    this.db.run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', user.id, user.email, user.name, Date.now());
    return user;
  }

  createSession(res: Res, userId: string): void {
    const sid = token();
    const maxAge = this.cfg.sessionDays * 86400;
    this.db.run('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(sid), userId, Date.now(), Date.now() + maxAge * 1000);
    res.setHeader('Set-Cookie', this.cookie(sid, maxAge));
  }

  private cookie(value: string, maxAge: number): string {
    const secure = this.cfg.baseUrl.startsWith('https://') ? '; Secure' : '';
    return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
  }

  userFor(req: Req): User | undefined {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!sid) return undefined;
    return this.db.get<User>(
      'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?',
      sha256(sid), Date.now(),
    );
  }

  require(req: Req): User {
    const u = this.userFor(req);
    if (!u) throw new HttpError(401, 'Sign in to continue', 'unauthenticated');
    return u;
  }

  logout(req: Req, res: Res): void {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) this.db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(sid));
    res.setHeader('Set-Cookie', this.cookie('', 0));
  }

  // ---- Google OAuth 2.0 (authorization code + PKCE) ----

  get googleEnabled(): boolean {
    return !!this.cfg.google;
  }

  private sign(v: string): string {
    return createHmac('sha256', this.cfg.secret).update(v).digest('base64url');
  }

  /** Returns the Google authorization URL and the state cookie to set. */
  googleStart(next: unknown): { url: string; cookie: string } {
    const g = this.cfg.google;
    if (!g) throw new HttpError(404, 'Google sign-in is not configured', 'not_configured');
    const state = token(16);
    const verifier = token(32);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const payload = Buffer.from(JSON.stringify({ state, verifier, next: safeNext(next), exp: Date.now() + 10 * 60 * 1000 })).toString('base64url');
    const u = new URL(g.authUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({
      client_id: g.clientId, redirect_uri: `${this.cfg.baseUrl}/api/auth/google/callback`, response_type: 'code',
      scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    }).toString();
    const secure = this.cfg.baseUrl.startsWith('https://') ? '; Secure' : '';
    return { url: u.toString(), cookie: `tl_oauth=${payload}.${this.sign(payload)}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=600${secure}` };
  }

  async googleCallback(req: Req, url: URL): Promise<{ user: User; next: string }> {
    const g = this.cfg.google;
    if (!g) throw new HttpError(404, 'Google sign-in is not configured', 'not_configured');
    const raw = parseCookies(req.headers.cookie).tl_oauth ?? '';
    const [payload, sig] = raw.split('.');
    const good = payload && sig && sig.length === this.sign(payload).length && timingSafeEqual(Buffer.from(sig), Buffer.from(this.sign(payload)));
    if (!good) throw new HttpError(400, 'Sign-in session expired; try again', 'bad_state');
    const st = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { state: string; verifier: string; next: string; exp: number };
    if (st.exp < Date.now() || url.searchParams.get('state') !== st.state) throw new HttpError(400, 'Sign-in session expired; try again', 'bad_state');
    const code = url.searchParams.get('code');
    if (!code) throw new HttpError(400, url.searchParams.get('error') ?? 'Google sign-in was cancelled', 'cancelled');
    const resp = await fetch(g.tokenUrl ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: g.clientId, client_secret: g.clientSecret, code_verifier: st.verifier,
        grant_type: 'authorization_code', redirect_uri: `${this.cfg.baseUrl}/api/auth/google/callback`,
      }),
    });
    if (!resp.ok) throw new HttpError(502, 'Google did not accept the sign-in', 'google_error');
    const { id_token } = (await resp.json()) as { id_token?: string };
    // The ID token comes straight from Google's token endpoint over TLS, so its
    // signature need not be re-verified (OpenID Connect Core 3.1.3.7); the
    // claims are still checked.
    const claims = JSON.parse(Buffer.from((id_token ?? '').split('.')[1] ?? '', 'base64url').toString() || '{}') as {
      iss?: string; aud?: string; exp?: number; email?: string; email_verified?: boolean; name?: string;
    };
    const issuers = g.issuer ? [g.issuer] : ['https://accounts.google.com', 'accounts.google.com'];
    const issOk = issuers.includes(claims.iss ?? '');
    if (!issOk || claims.aud !== g.clientId || !claims.exp || claims.exp * 1000 < Date.now() || !claims.email || claims.email_verified !== true) {
      throw new HttpError(400, 'Google account could not be verified', 'bad_id_token');
    }
    return { user: this.upsertUser(claims.email.toLowerCase(), claims.name), next: st.next };
  }

  // ---- Signed, short-lived media links ----

  signBlobUrl(key: string, ttlSec = 600): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `/blob/${key}?exp=${exp}&sig=${this.sign(`${key}:${exp}`)}`;
  }

  verifyBlob(key: string, exp: string | null, sig: string | null): boolean {
    if (!exp || !sig || Number(exp) * 1000 < Date.now()) return false;
    const want = this.sign(`${key}:${exp}`);
    return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  }
}
