import { spawn, spawnSync } from 'node:child_process';

const has = (command: string) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' }).status === 0;

/** Puts text on the system clipboard, or throws with what to install. */
export function copyToClipboard(text: string) {
  const candidates: Array<[string, string[]]> = process.platform === 'darwin' ? [['pbcopy', []]]
    : process.platform === 'win32' ? [['clip', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  const found = candidates.find(([command]) => has(command));
  if (!found) throw new Error('No clipboard tool found (install wl-copy, xclip, or xsel). Use json on and copy from the terminal instead.');
  const result = spawnSync(found[0], found[1], { input: text });
  if (result.status !== 0) throw new Error(`${found[0]} failed`);
}

/** Opens a file or directory with the system's default application. */
export function openWithSystem(path: string) {
  const [command, args] = process.platform === 'darwin' ? ['open', [path]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', path]]
    : ['xdg-open', [path]];
  if (process.platform === 'linux' && !has('xdg-open')) throw new Error('xdg-open is not available');
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}
