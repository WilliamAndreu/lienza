import { createInterface } from 'node:readline';
import { style, useColor } from './format.js';
import { EXIT, Session } from './session.js';
import { HISTORY_LIMIT, loadHistory, loadState, rememberFile, saveHistory, saveState } from './state.js';

/** The interactive program: `lienza [file.fig]`. Lines come from a terminal, or from a pipe for scripting. */
export async function startInteractive(figPath: string | undefined, options: { cliMain: string }) {
  const terminal = !!process.stdin.isTTY && !!process.stdout.isTTY;
  useColor(terminal);
  // Only a person at a terminal leaves history, recent files, and the first-run mark behind.
  const state = terminal ? loadState() : { recent: [] };
  const session = new Session({
    cliMain: options.cliMain, cwd: process.cwd(), write: text => process.stdout.write(text),
    recent: () => state.recent.map(item => item.path),
    remember: path => { if (terminal) rememberFile(state, path); },
  });
  session.banner({ opening: !!figPath, firstRun: terminal && !state.welcomed });
  if (terminal && !state.welcomed) { state.welcomed = true; saveState(state); }
  if (figPath) {
    try { await session.open(figPath); }
    catch (error) { process.stdout.write(`${style.red(`✖ ${error instanceof Error ? error.message : String(error)}`)}\n`); }
  }

  const rl = createInterface({
    input: process.stdin, output: process.stdout, terminal,
    history: terminal ? loadHistory() : [], historySize: HISTORY_LIMIT, removeHistoryDuplicates: true,
    completer: (line: string) => session.complete(line),
  });

  let closed = false;
  rl.on('close', () => { closed = true; });
  let interrupted = false;
  // Ctrl-C clears a typed line; on an empty line it asks for a second Ctrl-C before leaving.
  rl.on('SIGINT', () => {
    if (interrupted && !rl.line) { rl.close(); return; }
    interrupted = !rl.line;
    process.stdout.write(rl.line ? '\n' : `\n${style.gray('(Ctrl-C again or exit to leave)')}\n`);
    rl.write(null, { ctrl: true, name: 'e' });
    rl.write(null, { ctrl: true, name: 'u' });
  });

  rl.setPrompt(session.prompt());
  rl.prompt();
  for await (const line of rl) {
    interrupted = false;
    if (terminal && line.trim()) saveHistory(line.trim());
    if (!terminal && line.trim()) process.stdout.write(`${line}\n`);
    if ((await session.run(line)) === EXIT) break;
    // Piped input can end while a command runs; the remaining lines are still delivered.
    if (closed) continue;
    rl.setPrompt(session.prompt());
    rl.prompt();
  }
  if (!closed) rl.close();
  if (terminal) process.stdout.write('\n');
}
