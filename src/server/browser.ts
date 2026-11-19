/**
 * The headless browser the exporter draws frames in (VX-7, VX-8): Playwright's Chromium, or else an installed
 * Google Chrome or Microsoft Edge. One browser is kept while exports run and closed when they are done.
 */
import type { Browser } from 'playwright';

export class BrowserUnavailable extends Error {}

export const BROWSER_HELP =
  'Exports draw their frames in a Chromium browser, and none was found. In the TripAlogue folder run: npx playwright install chromium (or install Google Chrome), then export again.';

let shared: Promise<Browser> | undefined;
let users = 0;

/** A browser for one export; call release() when done. */
export async function acquireBrowser(log?: (m: string) => void): Promise<{ browser: Browser; release: () => Promise<void> }> {
  users += 1;
  try {
    shared ??= launch(log);
    const browser = await shared;
    return {
      browser,
      release: async () => {
        users -= 1;
        if (users === 0 && shared) {
          const b = shared;
          shared = undefined;
          await (await b).close().catch(() => {});
        }
      },
    };
  } catch (e) {
    users -= 1;
    shared = undefined;
    throw e;
  }
}

async function launch(log?: (m: string) => void): Promise<Browser> {
  let pw: typeof import('playwright');
  try {
    pw = await import('playwright');
  } catch {
    throw new BrowserUnavailable('Exports need the Playwright package: run npm install in the TripAlogue folder.');
  }
  const attempts: [string, () => Promise<Browser>][] = [
    ['Playwright Chromium', () => pw.chromium.launch({ headless: true })],
    ['Google Chrome', () => pw.chromium.launch({ headless: true, channel: 'chrome' })],
    ['Microsoft Edge', () => pw.chromium.launch({ headless: true, channel: 'msedge' })],
  ];
  for (const [name, go] of attempts) {
    try {
      const b = await go();
      log?.(`exports: drawing frames in ${name} ${b.version()}`);
      return b;
    } catch {
      /* try the next one */
    }
  }
  throw new BrowserUnavailable(BROWSER_HELP);
}
