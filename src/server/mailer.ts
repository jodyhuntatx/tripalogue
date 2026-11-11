/**
 * Outgoing email (sign-in links, invites, notifications).
 *
 * Phase 0 ships an outbox driver: each message is written as a JSON file in
 * <data>/outbox and its first link is logged, which is what development and
 * the tests use. A production deployment plugs a provider (SMTP or an email
 * API) into the same interface.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export class OutboxMailer implements Mailer {
  constructor(readonly dir: string, private readonly log: (m: string) => void = () => {}) {}

  async send(mail: Mail): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    await fs.writeFile(file, JSON.stringify({ ...mail, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    const link = /https?:\/\/\S+/.exec(mail.text)?.[0];
    this.log(`[mail] to ${mail.to}: ${mail.subject}${link ? `\n       ${link}` : ''}`);
  }

  /** Newest message for an address (tests and local development). */
  async latestFor(to: string): Promise<(Mail & { at: string }) | undefined> {
    let names: string[] = [];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.json')).sort().reverse();
    } catch {
      return undefined;
    }
    for (const n of names) {
      const m = JSON.parse(await fs.readFile(path.join(this.dir, n), 'utf8')) as Mail & { at: string };
      if (m.to.toLowerCase() === to.toLowerCase()) return m;
    }
    return undefined;
  }
}
