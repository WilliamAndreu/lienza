import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Per-user files of the interactive session. LIENZA_HOME moves them, for tests or several setups. */
const directory = () => process.env.LIENZA_HOME ?? join(homedir(), '.lienza');
const HISTORY_SIZE = 500;
const RECENT_SIZE = 10;

export interface CliState {
  welcomed?: boolean;
  recent: Array<{ path: string; openedAt: string }>;
}

export function loadState(): CliState {
  try {
    const state = JSON.parse(readFileSync(join(directory(), 'state.json'), 'utf8')) as Partial<CliState>;
    return { ...state, recent: Array.isArray(state.recent) ? state.recent : [] };
  } catch { return { recent: [] }; }
}

export function saveState(state: CliState) {
  try {
    mkdirSync(directory(), { recursive: true });
    writeFileSync(join(directory(), 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  } catch { /* the session works without it */ }
}

export function rememberFile(state: CliState, path: string) {
  state.recent = [{ path, openedAt: new Date().toISOString() }, ...state.recent.filter(item => item.path !== path)].slice(0, RECENT_SIZE);
  saveState(state);
}

export function loadHistory() {
  try { return readFileSync(join(directory(), 'history'), 'utf8').split('\n').filter(Boolean).slice(-HISTORY_SIZE).reverse(); }
  catch { return []; }
}

export function saveHistory(line: string) {
  try {
    mkdirSync(directory(), { recursive: true });
    appendFileSync(join(directory(), 'history'), `${line.replace(/\n/g, ' ')}\n`);
  } catch { /* history is a convenience */ }
}

export const HISTORY_LIMIT = HISTORY_SIZE;
