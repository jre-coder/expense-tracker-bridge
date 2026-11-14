/** Process entry: wires argv, env and the real fetch into main(). */
import { main } from './cli.js';

export function run(): void {
  main(process.argv.slice(2), {
    fetch: (url, init) => globalThis.fetch(url, init),
    env: process.env,
    cwd: process.cwd(),
    stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n'),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
