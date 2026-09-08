import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `//` is not a comment in JSX child position — it is text.
 *
 * This exists because of a bug that shipped. A `<td>` held
 *
 *     {deleted ? p.name : (
 *       // A real link, so the row is keyboard-reachable and
 *       // middle-click/⌘-click open a new tab like anywhere else.
 *       <Link …>{p.name}</Link>
 *     )}
 *
 * and a later edit removed the conditional. Deleting the `(` and `)` moved those
 * two lines out of a *JS expression*, where `//` is a comment, and into *JSX
 * children*, where it is a text node. The projects table then rendered
 * "// A real link, so the row is keyboard-reachable and // middle-click/⌘-click
 * open a new tab like anywhere else.blocker" as the project's name.
 *
 * Nothing caught it. It typechecked — a text node is valid JSX. 126 tests passed.
 * `next build` was clean. And it stayed invisible because every screenshot taken
 * of that table was of its *empty* state, so no row ever rendered until a real
 * project existed.
 *
 * So the guard is textual, and deliberately narrow: a `//` line is flagged only
 * when the previous non-blank line is an **opening tag**, which is the one place
 * JSX children begin.
 *
 * The first version was wider and also flagged a `//` after `return (`, which is
 * wrong — that is *expression* position, where a comment is a comment, and it
 * caught a legitimate one in `layout.tsx` on its first run. Narrowing it is the
 * right correction rather than excluding that file: a guard with a false positive
 * gets exclusions bolted on until it means nothing.
 *
 * It cannot see every variant a parser would. The alternative was to see none.
 */
const SRC = join(import.meta.dirname);

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Strips string and template literals so a `//` inside one is not a finding. */
function withoutLiterals(line: string): string {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

interface Finding { file: string; line: number; text: string }

function findJsxTextComments(file: string): Finding[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('//')) continue;

    // The nearest line above with content on it.
    let j = i - 1;
    while (j >= 0 && lines[j]!.trim() === '') j -= 1;
    if (j < 0) continue;
    const above = withoutLiterals(lines[j]!).trim();

    // `<div>` / `<Foo bar>` — children begin on the next line. A self-closing
    // `/>` or a closing `</…>` does not open a child position.
    const opensElement = /^<[A-Za-z][^>]*>$/.test(above)
      && !above.endsWith('/>')
      && !above.startsWith('</');
    if (opensElement) findings.push({ file, line: i + 1, text: trimmed.slice(0, 70) });
  }
  return findings;
}

describe('`//` comments are never in JSX child position', () => {
  const files = tsxFiles(SRC);

  it('finds .tsx files to check at all', () => {
    // A guard that scans nothing passes forever; this repo has had that before.
    expect(files.length).toBeGreaterThan(10);
  });

  it('has none in the app', () => {
    const findings = files.flatMap(findJsxTextComments);
    const report = findings
      .map((f) => `${f.file.slice(SRC.length + 1)}:${f.line}  ${f.text}`)
      .join('\n');
    expect(report, 'these render as text, not as comments — use {/* … */}').toBe('');
  });

  /**
   * The guard proven against the exact code that shipped. Without this, a
   * heuristic that silently matched nothing would look identical to a clean app.
   */
  it('flags the shape that shipped, and not the fixed version', () => {
    const broken = [
      '              <td className="sh-table__name">',
      '                // A real link, so the row is keyboard-reachable and',
      '                <Link href={`/project/${p.ref}`}>{p.name}</Link>',
      '              </td>',
    ].join('\n');
    const fixed = [
      '              <td className="sh-table__name">',
      '                {/* A real link, so the row is keyboard-reachable and */}',
      '                <Link href={`/project/${p.ref}`}>{p.name}</Link>',
      '              </td>',
    ].join('\n');

    expect(scan(broken)).toHaveLength(1);
    expect(scan(fixed)).toHaveLength(0);
  });

  it('does not flag expression position, which is where a comment is a comment', () => {
    // The false positive the first version of this guard produced, from
    // `layout.tsx`: between `return (` and the element, `//` is not a child.
    const expressionPosition = [
      '  return (',
      '    // suppressHydrationWarning is on <html> and nowhere else, because',
      '    <html lang="en" suppressHydrationWarning>',
      '      <head />',
      '    </html>',
      '  );',
    ].join('\n');
    expect(scan(expressionPosition)).toHaveLength(0);
  });

  it('leaves ordinary JS comments alone', () => {
    const ordinary = [
      'const x = 1;',
      '// a normal comment about the next statement',
      'const y = 2;',
      'function f() {',
      '  // inside a block',
      '  return 3;',
      '}',
      "const s = 'http://example.test';",
      '// after a string containing a double slash',
    ].join('\n');
    expect(scan(ordinary)).toHaveLength(0);
  });
});

/** The same rule, over a string, so the guard can be tested without a file. */
function scan(source: string): Finding[] {
  const lines = source.split('\n');
  const findings: Finding[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('//')) continue;
    let j = i - 1;
    while (j >= 0 && lines[j]!.trim() === '') j -= 1;
    if (j < 0) continue;
    const above = withoutLiterals(lines[j]!).trim();
    const opensElement = /^<[A-Za-z][^>]*>$/.test(above)
      && !above.endsWith('/>') && !above.startsWith('</');
    if (opensElement) findings.push({ file: '<inline>', line: i + 1, text: trimmed });
  }
  return findings;
}
