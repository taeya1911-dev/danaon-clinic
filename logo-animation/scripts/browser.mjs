/* browser.mjs — launch Chromium, preferring a browser already on the machine.
 *
 * Some environments ship a pre-installed Chromium under PLAYWRIGHT_BROWSERS_PATH
 * whose build number does not match the installed playwright package. Rather than
 * re-downloading a browser, resolve whatever is actually there and point at it.
 */
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LAUNCH_ARGS = [
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--font-render-hinting=none',
  '--hide-scrollbars'
];

function findLocalChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return null;

  const candidates = [];
  for (const entry of readdirSync(base)) {
    if (!/^chromium/.test(entry)) continue;
    candidates.push(
      join(base, entry, 'chrome-linux', 'chrome'),
      join(base, entry, 'chrome-linux', 'headless_shell'),
      join(base, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      join(base, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
    );
  }
  // Prefer full chrome over headless_shell: the shell build lacks some rendering paths.
  candidates.sort((a, b) => (a.endsWith('/chrome') ? -1 : 1) - (b.endsWith('/chrome') ? -1 : 1));
  return candidates.find(existsSync) || null;
}

export async function launch() {
  const executablePath = findLocalChromium();
  try {
    return await chromium.launch(executablePath ? { executablePath, args: LAUNCH_ARGS } : { args: LAUNCH_ARGS });
  } catch (err) {
    if (executablePath) {
      // Fall back to whatever playwright manages itself, if anything.
      return chromium.launch({ args: LAUNCH_ARGS });
    }
    throw err;
  }
}
