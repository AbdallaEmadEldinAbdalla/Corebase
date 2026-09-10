import { describe, it, expect } from 'vitest';
import { classify } from '@steadhold/sql-guard';
import {
  Impossible, addColumn, addPrimaryKey, changeType, createTable, dropColumn, dropDefault,
  dropNotNull, dropTable, enableRls, migrationName, renameColumn, renameTable,
  Incomplete, addCheck, addForeignKey, addUnique, createIndex, describeFailure,
  dropConstraint, dropIndex, grantAnonRead, indexName, revokeAnonAccess,
  rowsPhrase, setDefault, setNotNull, type TableFacts,
} from './ddl.ts';

/**
 * The compiler's output is **shown to the user and then run against their
 * production database**, which makes two different things testable here.
 *
 * The first is correctness: the statement has to be the statement. The second is
 * *honesty* — the notices are the only warning anyone gets before a table
 * rewrite, so a missing one is a defect of the same kind as wrong SQL. Both are
 * asserted; the notices are not decoration.
 */
const posts: TableFacts = { schema: 'public', table: 'posts', rowsEstimate: 250 };
const empty: TableFacts = { schema: 'public', table: 'fresh', rowsEstimate: 0 };
const unknown: TableFacts = { schema: 'public', table: 'never', rowsEstimate: -1 };

const noticeText = (p: { notices: { text: string }[] }) =>
  p.notices.map((n) => n.text).join(' ');

describe('create table', () => {
  it('gives every table an id and a created_at, so zero fields changed works', () => {
    const { sql } = createTable('public', 'posts', []);
    expect(sql).toContain('"id" uuid primary key default gen_random_uuid()');
    expect(sql).toContain('"created_at" timestamptz not null default now()');
  });

  it('appends RLS in the preview rather than hiding it (D-083)', () => {
    // The doc is explicit that the ALTER is "always appended, shown in the
    // preview, not hidden". Hiding it would leave the user's mental model of
    // their own schema missing the most important thing about it.
    const { sql } = createTable('public', 'posts', []);
    expect(sql).toContain('alter table "public"."posts" enable row level security;');
  });

  it('BYPASS: does NOT force RLS, because D-191 superseded that half of D-083', () => {
    /**
     * The table-editor doc's worked example shows `enable` **and** `force`, and
     * following it would have shipped a create-table flow whose first `INSERT`
     * fails.
     *
     * `FORCE` applies the policies to the table's *owner*, the owner is the
     * customer's own `developer` role, and a forced table with no policies
     * rejects the owner's own insert with "new row violates row-level security
     * policy" — breaking every ORM, migration tool and seed script on a
     * brand-new project. That is exactly what D-191 was written about, and the
     * decision log wins when two documents disagree.
     *
     * It would also have made the table page contradict itself: `RlsPanel` tells
     * every developer that the grid is the owner's view and ignores the policies,
     * which is true of an enabled table and false of a forced one — and
     * introspection reports `relrowsecurity`, not `relforcerowsecurity`, so the
     * panel could not have told the difference.
     */
    expect(createTable('public', 'posts', []).sql).not.toContain('force');
  });

  it('BYPASS: distinguishes how the two API roles fail, because they differ', () => {
    /**
     * Measured on a live project, not reasoned. `authenticated` holds the default
     * table grant (D-108), so RLS filters and it gets `[]`. `anon` holds **no
     * grant at all**, so it gets `permission denied for table …` — and a policy
     * does not change that: verified against a table carrying
     * `create policy … to anon using (true)`, still denied.
     *
     * The earlier wording was "your API returns no rows from this table", which
     * flattens those into one claim and is wrong for half of it. A developer
     * told that writes the policy, still gets an error, and concludes the policy
     * engine is broken.
     */
    const text = noticeText(createTable('public', 'posts', []));
    expect(text).toContain('empty list');
    expect(text).toContain('refused outright');
    // And the half that stops it reading as a broken table.
    expect(text).toContain('because you own it');
  });

  it('carries the columns the user asked for, in order, after the defaults', () => {
    const { sql } = createTable('public', 'posts', [
      { name: 'title', type: 'text', nullable: false },
      { name: 'body', type: 'text', nullable: true },
    ]);
    expect(sql).toContain('"title" text not null');
    expect(sql).toContain('"body" text');
    expect(sql.indexOf('"created_at"')).toBeLessThan(sql.indexOf('"title"'));
  });

  it('refuses a nameless table or a typeless column rather than emitting broken SQL', () => {
    expect(() => createTable('public', '  ', [])).toThrow(Impossible);
    expect(() => createTable('public', 't', [{ name: 'x', type: '', nullable: true }]))
      .toThrow(Impossible);
  });

  it('BYPASS: an unfilled form is `Incomplete`, not a refusal', () => {
    /**
     * The distinction the dialog renders differently, and the reason it exists:
     * "the table needs a name" is the state every create dialog is in the moment
     * it opens, so drawing it as a warning means every dialog in the editor
     * greets the user with something that looks like a problem.
     *
     * `Incomplete` extends `Impossible`, so the `instanceof Incomplete` check
     * must come *first* at the call site — reversed, every unfinished form
     * renders as a refusal and this distinction silently does nothing.
     */
    expect(() => createTable('public', '  ', [])).toThrow(Incomplete);
    expect(() => renameTable(posts, 'posts')).toThrow(Incomplete);
    expect(() => setDefault(posts, 'a', '')).toThrow(Incomplete);
    expect(() => addPrimaryKey(posts, [])).toThrow(Incomplete);
  });

  it('BYPASS: a genuine refusal is NOT `Incomplete`', () => {
    // NOT NULL with no default on a table with rows cannot succeed however the
    // form is filled in, so it must reach the warning rather than the muted line.
    let caught: unknown;
    try {
      addColumn(posts, { name: 'status', type: 'text', nullable: false });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(Impossible);
    expect(caught).not.toBeInstanceOf(Incomplete);
  });

  it('BYPASS: a name carrying SQL is one quoted identifier, not two statements', () => {
    const { sql } = createTable('public', 'x"; drop table users; --', []);
    expect(sql).toContain('"x""; drop table users; --"');
    /**
     * Asked of the real lexer, because the obvious check is wrong.
     *
     * The first version of this test split on `;` and counted — which fails,
     * since a naive split cuts *inside* the quoted identifier and finds three
     * fragments, one of which reads `drop table users`. That is exactly the
     * reasoning error `packages/sql-guard/src/lex.ts` exists to prevent, and
     * writing the weaker assertion first is how you find out the strong one
     * matters. The same classifier the server runs is the only witness worth
     * having here (D-134).
     */
    const script = classify(sql);
    expect(script.statements.map((st) => st.command))
      .toEqual(['CREATE', 'ALTER']);
    expect(script.danger).toBe('safe');
  });
});

describe('rename', () => {
  it('names the endpoint that stops existing', () => {
    // The cost of a rename is entirely outside the database, and nothing in
    // Postgres will mention it.
    const text = noticeText(renameTable(posts, 'articles'));
    expect(text).toContain('/rest/v1/posts');
    expect(text).toContain('/rest/v1/articles');
    expect(text).toContain('404');
  });

  it('carries no lock warning, because a rename is a catalog update', () => {
    // A lock notice on an instant operation is how warnings become wallpaper.
    expect(renameTable(posts, 'articles').notices.some((n) => n.kind === 'lock'))
      .toBe(false);
  });

  it('names the API field that changes, for a column', () => {
    expect(noticeText(renameColumn(posts, 'status', 'state'))).toContain('"status"');
    expect(renameColumn(posts, 'status', 'state').sql)
      .toBe('alter table "public"."posts" rename column "status" to "state";');
  });

  it('refuses a rename to the same name', () => {
    expect(() => renameTable(posts, 'posts')).toThrow(Impossible);
    expect(() => renameColumn(posts, 'status', 'status')).toThrow(Impossible);
  });
});

describe('drop table', () => {
  it('writes RESTRICT out even though it is the default', () => {
    // The value of a preview is that it says what will happen. A reader who does
    // not know the default cannot tell a safe drop from a cascading one, and
    // that is the difference between losing one table and losing five.
    expect(dropTable(posts, false).sql).toBe('drop table "public"."posts" restrict;');
  });

  it('says what CASCADE takes with it', () => {
    const p = dropTable(posts, true);
    expect(p.sql).toBe('drop table "public"."posts" cascade;');
    expect(noticeText(p)).toContain('depends on this table');
  });

  it('presents RESTRICT refusal as the useful outcome, not a failure', () => {
    expect(noticeText(dropTable(posts, false))).toContain('refuses');
  });
});

describe('add column', () => {
  it('BYPASS: refuses NOT NULL with no default on a table with rows', () => {
    // The doc asks for this refusal, and the reason lives with the rule so it
    // travels: there is no value to put in the existing rows, and Postgres's own
    // error names the constraint rather than the fix.
    expect(() => addColumn(posts, { name: 'status', type: 'text', nullable: false }))
      .toThrow(/no default has no value to put in them/);
  });

  it('names the table in prose without SQL quotes', () => {
    // `qualified()` is for SQL, where the quotes are the safety property. In a
    // sentence they are punctuation the reader has to parse before reaching the
    // fact — the same correction the classifier needed for the name it asks the
    // user to type.
    expect(() => addColumn(posts, { name: 's', type: 'text', nullable: false }))
      .toThrow(/^public\.posts holds/);
  });

  it('allows it on an empty table, where there are no rows to fill', () => {
    expect(addColumn(empty, { name: 'status', type: 'text', nullable: false }).sql)
      .toContain('add column "status" text not null');
  });

  it('refuses it when the row count is UNKNOWN, not just when it is positive', () => {
    // `-1` means never analysed. Refusing on unknown costs the user one field;
    // allowing it costs them a confirmed statement that fails in the database
    // and a reason to distrust the preview.
    expect(() => addColumn(unknown, { name: 's', type: 'text', nullable: false }))
      .toThrow(Impossible);
  });

  it('allows NOT NULL with a default on a table with rows', () => {
    const p = addColumn(posts, {
      name: 'status', type: 'text', nullable: false, default: "'draft'" });
    expect(p.sql).toContain(`add column "status" text not null default 'draft'`);
    // Since Postgres 11 this is metadata-only, so no lock warning.
    expect(p.notices).toHaveLength(0);
  });

  it('warns only when the default computes a different value per row', () => {
    // A constant default is metadata-only; a volatile one is a full rewrite.
    // Warning about both would make the warning meaningless.
    const constant = addColumn(posts, {
      name: 'a', type: 'int', nullable: false, default: '0' });
    expect(constant.notices).toHaveLength(0);

    const volatile = addColumn(posts, {
      name: 'b', type: 'uuid', nullable: false, default: 'gen_random_uuid()' });
    expect(volatile.notices.some((n) => n.kind === 'lock')).toBe(true);
    expect(noticeText(volatile)).toContain('ACCESS EXCLUSIVE');
  });
});

describe('change type', () => {
  it('always emits an explicit USING, pre-filled with the straight cast', () => {
    // Always, even where Postgres would infer it: an inferred cast is a cast the
    // user cannot see, so a text→integer change on a column holding "n/a" looks
    // safe in the preview and fails in the database.
    expect(changeType(posts, 'price', 'numeric(10,2)').sql)
      .toContain('using "price"::numeric(10,2)');
  });

  it("uses the user's own USING when they wrote one", () => {
    const { sql } = changeType(posts, 'price', 'numeric', "nullif(price,'')::numeric");
    expect(sql).toContain("using nullif(price,'')::numeric");
    expect(sql).not.toContain('"price"::numeric');
  });

  it('states the lock, the rewrite and the row count', () => {
    const text = noticeText(changeType(posts, 'price', 'numeric'));
    expect(text).toContain('ACCESS EXCLUSIVE');
    expect(text).toContain('about 250 rows');
  });

  it('says the statement is all-or-nothing, because that is the reassuring part', () => {
    expect(noticeText(changeType(posts, 'price', 'numeric')))
      .toContain('either succeeds completely or changes nothing');
  });
});

describe('the constraint operations', () => {
  it('SET NOT NULL warns about the scan, not a rewrite — it does not rewrite', () => {
    const p = setNotNull(posts, 'title');
    expect(p.sql).toBe('alter table "public"."posts" alter column "title" set not null;');
    expect(p.notices[0]!.kind).toBe('scan');
    expect(noticeText(p)).toContain('about 250 rows');
    expect(noticeText(p)).not.toContain('ACCESS EXCLUSIVE');
  });

  it('DROP NOT NULL warns downstream, because the database cost is nil', () => {
    expect(dropNotNull(posts, 'title').notices[0]!.kind).toBe('api');
  });

  it('SET DEFAULT says it does not touch existing rows', () => {
    // The single most common wrong expectation about a default.
    expect(noticeText(setDefault(posts, 'status', "'draft'")))
      .toContain('Existing rows are not');
  });

  it('SET DEFAULT refuses an empty expression', () => {
    expect(() => setDefault(posts, 'status', '   ')).toThrow(Impossible);
  });

  it('DROP DEFAULT is the one operation with nothing to warn about', () => {
    const p = dropDefault(posts, 'status');
    expect(p.sql).toBe('alter table "public"."posts" alter column "status" drop default;');
    expect(p.notices).toEqual([]);
  });

  it('DROP COLUMN says the data goes, and that a backup is the only way back', () => {
    expect(noticeText(dropColumn(posts, 'legacy_flag'))).toContain('backup restore');
  });
});

describe('enable RLS', () => {
  it('does NOT force it, unlike create-table', () => {
    /**
     * The one deliberate divergence from the doc's worked example.
     *
     * Forcing RLS on a table that already has data makes the developer's *own*
     * next query return nothing — from their connection string as well as this
     * grid — so the fix for "anyone with the anon key can read this table" would
     * present as "my database is empty". Enabling without forcing closes the
     * hole the banner is about and matches every other table in the project
     * (`30-force-rls.sql`).
     */
    const { sql } = enableRls(posts);
    expect(sql).toBe('alter table "public"."posts" enable row level security;');
    expect(sql).not.toContain('force');
  });

  it('says the owner still sees every row, which is why the grid will not change', () => {
    expect(noticeText(enableRls(posts))).toContain('you own');
  });
});

describe('row counts in the notices', () => {
  it('never renders a never-analysed table as zero rows', () => {
    // A lock warning saying "this rewrites 0 rows" on a table holding a million
    // is worse than one that admits it does not know, because the number would
    // be believed — and it is the number that decides whether someone runs this
    // now or at 3am.
    expect(rowsPhrase(-1)).toContain('never been analysed');
    expect(rowsPhrase(-1)).not.toContain('0');
    expect(noticeText(changeType(unknown, 'a', 'text'))).toContain('never been analysed');
  });

  it('keeps the lock warning when the count is unknown, because the lock is certain', () => {
    expect(noticeText(changeType(unknown, 'a', 'text'))).toContain('ACCESS EXCLUSIVE');
  });

  it('distinguishes "no rows" from "unknown"', () => {
    expect(rowsPhrase(0)).toContain('no rows');
    expect(rowsPhrase(0)).not.toContain('never been analysed');
  });

  it('groups thousands, because 1200000 is unreadable', () => {
    expect(rowsPhrase(1_200_000)).toContain('1,200,000');
  });
});

describe('the migration filename (D-028)', () => {
  const at = new Date(2026, 8, 9, 14, 5, 3);

  it('is a timestamp and a slug, like the ones in the repo', () => {
    expect(migrationName('create_posts', at)).toBe('20260909140503_create_posts.sql');
  });

  it('pads every field, so filenames sort chronologically as strings', () => {
    // The whole point of the format. `2026-9-9` would sort after `2026-10-1`.
    expect(migrationName('x', new Date(2026, 0, 2, 3, 4, 5)))
      .toBe('20260102030405_x.sql');
  });

  it('flattens anything that is not a letter or a digit', () => {
    expect(migrationName('Add "status" to posts!', at))
      .toBe('20260909140503_add_status_to_posts.sql');
  });

  it('never produces a bare timestamp when the slug flattens to nothing', () => {
    expect(migrationName('!!!', at)).toBe('20260909140503_change.sql');
  });
});

describe('every plan', () => {
  const all = [
    createTable('public', 'posts', []),
    renameTable(posts, 'articles'),
    dropTable(posts, false),
    addColumn(posts, { name: 'a', type: 'text', nullable: true }),
    renameColumn(posts, 'a', 'b'),
    changeType(posts, 'a', 'text'),
    dropColumn(posts, 'a'),
    setNotNull(posts, 'a'),
    dropNotNull(posts, 'a'),
    setDefault(posts, 'a', "'x'"),
    dropDefault(posts, 'a'),
    enableRls(posts),
  ];

  it('ends its statements with a semicolon, so a script concatenates', () => {
    for (const p of all) expect(p.sql.trimEnd().endsWith(';'), p.sql).toBe(true);
  });

  it('qualifies its table, so the statement does not depend on search_path', () => {
    // A statement that works in the editor and fails in a migration file because
    // `search_path` differs is the worst kind of generated SQL.
    for (const p of all.slice(1)) expect(p.sql, p.sql).toContain('"public"."posts"');
  });

  it('quotes every identifier it interpolates', () => {
    for (const p of all) {
      // No bare `posts` outside quotes anywhere in the statement.
      expect(p.sql.replace(/"[^"]*"/g, ''), p.sql).not.toMatch(/\bposts\b/);
    }
  });

  it('has a past-tense toast line with no full stop', () => {
    for (const p of all) {
      expect(p.done.length, p.done).toBeGreaterThan(3);
      expect(p.done.endsWith('.'), p.done).toBe(false);
    }
  });

  it('names a .sql file that is safe to write to disk', () => {
    for (const p of all) expect(p.filename).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });
});

describe('add primary key', () => {
  it('quotes and comma-joins a composite key', () => {
    expect(addPrimaryKey(posts, ['tenant', 'id']).sql)
      .toBe('alter table "public"."posts" add primary key ("tenant", "id");');
  });

  it('names the NOT NULL that Postgres adds without saying so', () => {
    // The statement does not mention it, and it changes the table's contract
    // with every client that was sending null.
    expect(noticeText(addPrimaryKey(posts, ['id']))).toContain('NOT NULL');
  });

  it('presents a duplicate-value failure as the useful outcome', () => {
    expect(noticeText(addPrimaryKey(posts, ['id']))).toContain('find the duplicates');
  });

  it('refuses an empty column list', () => {
    expect(() => addPrimaryKey(posts, [])).toThrow(Impossible);
  });
});

describe('describeFailure — the order-dependent check, extracted so it can be tested', () => {
  const of = (fn: () => unknown) => {
    try { fn(); } catch (err) { return describeFailure(err); }
    throw new Error('expected a throw');
  };

  it('BYPASS: an unfilled form is a todo, not a refusal', () => {
    // `Incomplete extends Impossible`, so checking the general case first makes
    // every unfinished form a refusal — and every dialog in the editor would
    // then open showing something that looks like a problem. No type checker
    // sees that, which is why it is asserted here.
    expect(of(() => createTable('public', '', []))).toEqual({ todo: 'Name the table.' });
    expect(of(() => renameTable(posts, 'posts'))).toHaveProperty('todo');
    expect(of(() => addPrimaryKey(posts, []))).toHaveProperty('todo');
  });

  it('a statement that cannot work is a refusal', () => {
    const got = of(() => addColumn(posts, { name: 'a', type: 'text', nullable: false }));
    expect(got).toHaveProperty('refusal');
    expect((got as { refusal: string }).refusal).toContain('no value to put in them');
  });

  it('rethrows anything that is not one of the two, rather than swallowing it', () => {
    // A real fault must not render as a friendly hint. `Impossible` is expected
    // control flow; a TypeError is a bug, and hiding it behind a muted line in a
    // dialog is how it survives.
    expect(() => describeFailure(new TypeError('x is not a function'))).toThrow(TypeError);
  });
});

describe('anonymous access, which is opt-in per table (D-108)', () => {
  it('grants SELECT only, to anon, on the qualified table', () => {
    expect(grantAnonRead(posts).sql)
      .toBe('grant select on "public"."posts" to anon;');
  });

  it('BYPASS: says the grant is what makes an anon policy work at all', () => {
    // The step nothing else does for you. Without it a correct `to anon` policy
    // yields `permission denied`, which reads as the policy being wrong.
    expect(noticeText(grantAnonRead(posts)))
      .toContain('makes a policy for anon take effect');
  });

  it('the classifier puts it on the confirm rung, not on safe', () => {
    // The rung is the server's; this asserts the two agree, since a dialog that
    // did not ask would send an unconfirmed statement and get a 409.
    expect(classify(grantAnonRead(posts).sql).danger).toBe('confirm');
  });

  it('revoking is safe and needs no ceremony', () => {
    expect(revokeAnonAccess(posts).sql)
      .toBe('revoke all on "public"."posts" from anon;');
    expect(classify(revokeAnonAccess(posts).sql).danger).toBe('safe');
  });

  it('says a grant sits above RLS, which is why revoking is the coarse switch', () => {
    expect(noticeText(revokeAnonAccess(posts))).toContain('above RLS');
  });
});

describe('indexes and constraints — the half that needed no new API', () => {
  it('names an index the way the doc does, so it looks hand-written', () => {
    expect(indexName('posts', ['author_id'])).toBe('idx_posts_author_id');
    expect(createIndex(posts, ['author_id'], { unique: false }).sql)
      .toContain('create index "idx_posts_author_id"');
  });

  it('BYPASS: emits no IF NOT EXISTS, which sounds free and is not', () => {
    // `IF NOT EXISTS` matches on the *name*, so an index already covering these
    // columns under a different name is invisible to it and a duplicate gets
    // built anyway — doubling the table's write cost silently. Failing with
    // "relation already exists" is the more useful outcome.
    expect(createIndex(posts, ['a'], { unique: false }).sql).not.toContain('if not exists');
  });

  it('says why CONCURRENTLY is unavailable, rather than leaving it unmentioned', () => {
    // Not just OQ-132 being undecided: `CREATE INDEX CONCURRENTLY` cannot run
    // inside a transaction and the console runs every script in one (D-464), so
    // it needs a non-transactional lane in the execution path — a server change,
    // not a preference.
    const text = noticeText(createIndex(posts, ['a'], { unique: false }));
    expect(text).toContain('blocks writes');
    expect(text).toContain('cannot run inside a transaction');
  });

  it('a unique index warns about existing duplicates; a plain one does not', () => {
    expect(noticeText(createIndex(posts, ['a'], { unique: true })))
      .toContain('already share these values');
    expect(noticeText(createIndex(posts, ['a'], { unique: false })))
      .not.toContain('already share these values');
    expect(createIndex(posts, ['a'], { unique: true }).sql).toContain('create unique index');
  });

  describe('the foreign key', () => {
    const fk = {
      column: 'author_id', targetSchema: 'public', targetTable: 'users',
      targetColumn: 'id', onDelete: 'cascade',
    };

    it('builds the constraint with the conventional name', () => {
      const { sql } = addForeignKey(posts, fk);
      expect(sql).toContain('add constraint "posts_author_id_fkey"');
      expect(sql).toContain('foreign key ("author_id")');
      expect(sql).toContain('references "public"."users" ("id")');
      expect(sql).toContain('on delete cascade');
    });

    it('omits ON DELETE when none was chosen, rather than inventing one', () => {
      // Postgres's default is NO ACTION, and writing a different one out would
      // be the editor choosing referential semantics on the user's behalf.
      const { column, targetSchema, targetTable, targetColumn } = fk;
      expect(addForeignKey(posts, { column, targetSchema, targetTable, targetColumn }).sql)
        .not.toContain('on delete');
    });

    it("BYPASS: states the fan-in cost AND that it cannot check the condition", () => {
      /**
       * The doc asks for this notice *conditionally* — "if the referencing
       * column has no index". Introspection returns no indexes, so the condition
       * cannot be evaluated. Saying the consequence and admitting the
       * uncertainty is honest; printing the warning as though the index were
       * known to be missing would be inventing a fact.
       */
      const text = noticeText(addForeignKey(posts, fk));
      expect(text).toContain('has to scan');
      expect(text).toContain('cannot tell');
    });

    it('appends the index when asked, and then drops the uncertainty notice', () => {
      const withIndex = addForeignKey(posts, { ...fk, alsoIndex: true });
      expect(withIndex.sql).toContain('create index "idx_posts_author_id"');
      // No longer uncertain — the index is in the statement.
      expect(noticeText(withIndex)).not.toContain('cannot see your indexes');
    });

    it('refuses until every end of the reference is chosen', () => {
      expect(() => addForeignKey(posts, { ...fk, column: '' })).toThrow(Incomplete);
      expect(() => addForeignKey(posts, { ...fk, targetTable: '' })).toThrow(Incomplete);
      expect(() => addForeignKey(posts, { ...fk, targetColumn: '' })).toThrow(Incomplete);
    });
  });

  it('CHECK carries the expression verbatim and warns about existing rows', () => {
    const p = addCheck(posts, 'price >= 0');
    expect(p.sql).toContain('check (price >= 0)');
    expect(noticeText(p)).toContain('does not match the rule you thought it followed');
  });

  it('UNIQUE across several columns says uniqueness is of the combination', () => {
    // The single most common wrong expectation about a composite unique
    // constraint.
    const p = addUnique(posts, ['tenant', 'slug']);
    expect(p.sql).toContain('unique ("tenant", "slug")');
    expect(noticeText(p)).toContain('across the combination');
    expect(noticeText(addUnique(posts, ['slug']))).not.toContain('across the combination');
  });

  it('every new statement still ends in a semicolon and quotes its identifiers', () => {
    for (const p of [
      createIndex(posts, ['a'], { unique: false }),
      addForeignKey(posts, {
        column: 'a', targetSchema: 'public', targetTable: 'u', targetColumn: 'id' }),
      addCheck(posts, 'a > 0'),
      addUnique(posts, ['a']),
    ]) {
      expect(p.sql.trimEnd().endsWith(';'), p.sql).toBe(true);
      expect(p.sql, p.sql).toContain('"public"."posts"');
      expect(p.filename).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    }
  });
});

describe('dropping an index or a constraint (P7o)', () => {
  it('qualifies the index, because an unqualified name resolves against search_path', () => {
    expect(dropIndex('public', 'idx_posts_status').sql)
      .toBe('drop index "public"."idx_posts_status";');
  });

  it('BYPASS: says something different about an invalid index', () => {
    // "Queries relying on this index will get slower" is a warning about
    // something that cannot happen: Postgres refuses to use an invalid index at
    // all. It is costing writes and serving nothing, so there is no downside to
    // warn about — and saying there is would train the reader to discount the
    // notices that matter.
    const bad = noticeText(dropIndex('public', 'idx_bad', { invalid: true }));
    expect(bad).toContain('will not use it');
    expect(bad).not.toContain('get slower');
    expect(noticeText(dropIndex('public', 'idx_ok'))).toContain('get slower');
  });

  it('BYPASS: dropping a primary key names the product consequence', () => {
    /**
     * The consequence no Postgres message mentions and no SQL warning covers:
     * the grid becomes read-only, because PK-guarded DML is the only UPDATE
     * shape that cannot silently hit more rows than the user can see (D-133),
     * and paging stops being stable. This is the only place it can be said.
     */
    const text = noticeText(dropConstraint(posts, 'posts_pkey', 'primary_key'));
    expect(text).toContain('read-only');
    expect(text).toContain('appear twice or not at all');
    // And it is not blocked — it is the customer's database.
    expect(dropConstraint(posts, 'posts_pkey', 'primary_key').sql)
      .toBe('alter table "public"."posts" drop constraint "posts_pkey";');
  });

  it('says the index goes too, for a primary key or a unique constraint', () => {
    expect(noticeText(dropConstraint(posts, 'posts_slug_key', 'unique')))
      .toContain('index behind this constraint is dropped');
    expect(noticeText(dropConstraint(posts, 'posts_pkey', 'primary_key')))
      .toContain('index behind it goes too');
  });

  it('a foreign key drop is about dangling references, not about rejected writes', () => {
    // Two genuinely different consequences, and the generic sentence is wrong
    // for the FK: nothing was being *rejected* that now succeeds — rows start
    // being able to point at nothing.
    expect(noticeText(dropConstraint(posts, 'posts_author_fkey', 'foreign_key')))
      .toContain('point at rows that do not exist');
    expect(noticeText(dropConstraint(posts, 'posts_check', 'check')))
      .toContain('would have been rejected');
  });

  it('never claims a drop checked or changed existing data', () => {
    for (const kind of ['primary_key', 'unique', 'check', 'foreign_key']) {
      expect(noticeText(dropConstraint(posts, 'c', kind)), kind)
        .toContain('not checked or changed');
    }
  });
});

describe('the fan-in warning, now that the condition is answerable', () => {
  const fk = {
    column: 'author_id', targetSchema: 'public', targetTable: 'users',
    targetColumn: 'id',
  };

  it('says nothing when the column is already indexed', () => {
    expect(noticeText(addForeignKey(posts, { ...fk, indexed: true })))
      .not.toContain('scan');
  });

  it('BYPASS: states it as fact when it knows there is no index', () => {
    const text = noticeText(addForeignKey(posts, { ...fk, indexed: false }));
    expect(text).toContain('has no index leading with it');
    expect(text).toContain('will scan');
    // Not hedged — the caller has the list, so hedging would be false modesty
    // that makes a real warning sound optional.
    expect(text).not.toContain('cannot tell you');
  });

  it('keeps the admitted-unknown wording when the caller has no list', () => {
    // The branch stays rather than being deleted: a caller without the index
    // list must say so instead of implying the reassuring answer, and *absent*
    // is the only value that cannot be mistaken for "no".
    const text = noticeText(addForeignKey(posts, fk));
    expect(text).toContain('cannot tell');
    expect(text).toContain('Unless');
  });

  it('ticking the index suppresses the warning whatever the condition says', () => {
    for (const indexed of [undefined, false]) {
      const p = addForeignKey(posts, { ...fk, alsoIndex: true, ...(indexed === undefined ? {} : { indexed }) });
      expect(noticeText(p)).not.toContain('scan');
      expect(p.sql).toContain('create index "idx_posts_author_id"');
    }
  });
});
