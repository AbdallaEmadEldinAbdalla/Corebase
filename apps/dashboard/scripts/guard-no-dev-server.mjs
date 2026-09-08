import { createConnection } from 'node:net';

/**
 * Refuse to build while `next dev` is serving.
 *
 * `next build` and `next dev` write the same `.next` directory. Running one while
 * the other is live corrupts it, and the symptom is not a build error — it is the
 * *running app* breaking afterwards, with `Cannot find module './249.js'` or a
 * route bundle referencing a vendor chunk that is no longer on disk. That reads as
 * an application bug, so the time goes into the wrong place.
 *
 * This happened three times in this project. Twice it was diagnosed, written down,
 * and then done again — remembering is not a mechanism. The port is: if something
 * is listening where the dev server runs, the build stops and says what to do.
 */
const PORT = Number(process.env.PORT ?? 3000);

const socket = createConnection({ host: '127.0.0.1', port: PORT });
socket.setTimeout(700);

const clear = () => { socket.destroy(); process.exit(0); };
socket.on('error', clear);      // nothing listening — the normal case
socket.on('timeout', clear);

socket.on('connect', () => {
  socket.destroy();
  process.stderr.write(
    `\n  Something is listening on :${PORT}, which is where \`next dev\` runs.\n\n`
    + '  `next build` and `next dev` share the .next directory, and building now\n'
    + '  corrupts it — the dev server then fails with missing chunk modules that\n'
    + '  look like application bugs.\n\n'
    + '  Stop the dev server first, or run the build with a different PORT.\n\n');
  process.exit(1);
});
