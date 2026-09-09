import { describe, it, expect } from 'vitest';
import { namesSatisfied } from './confirm.ts';

/**
 * This predicate gates the confirm button on every destructive operation, so a
 * bug in it presents as "I typed the name and nothing happened" — a dialog that
 * looks broken, with nothing on screen to explain it. It has no rendering test
 * (this app has no DOM test environment), which is exactly why the rule lives in
 * a module rather than inside the component.
 */
describe('the typed confirmation', () => {
  it('accepts the name, exactly', () => {
    expect(namesSatisfied(['legacy_flag'], 'legacy_flag')).toBe(true);
    expect(namesSatisfied(['public.posts'], 'public.posts')).toBe(true);
  });

  it('ignores surrounding whitespace, which is what a paste leaves behind', () => {
    expect(namesSatisfied(['posts'], '  posts \n')).toBe(true);
  });

  it('BYPASS: accepts commas between names, because the label says "and"', () => {
    // The label reads "Type `a` and `b` to confirm". Matching on whitespace
    // alone leaves someone who wrote `a, b` staring at a disabled button with
    // no explanation — a confirmation that looks broken.
    expect(namesSatisfied(['a', 'b'], 'a, b')).toBe(true);
    expect(namesSatisfied(['a', 'b'], 'a,b')).toBe(true);
    expect(namesSatisfied(['a', 'b'], 'a b')).toBe(true);
  });

  it('does not care about order, or about extra words', () => {
    // Someone who types "drop a and b" has demonstrated they read the question.
    // Refusing it would be pedantry dressed as safety.
    expect(namesSatisfied(['a', 'b'], 'b a')).toBe(true);
    expect(namesSatisfied(['a', 'b'], 'drop a and b')).toBe(true);
  });

  it('BYPASS: a quoted name containing a space still matches', () => {
    /**
     * The case a whitespace split cannot handle. The guard keeps the quotes on
     * `"odd name"` because dropping them changes which identifier it is, so that
     * whole string — quotes and space — is what the user is shown and asked for.
     * Splitting on whitespace first tears it into `"odd` and `name"`, and the
     * button could never enable however carefully they typed.
     */
    expect(namesSatisfied(['"odd name"'], '"odd name"')).toBe(true);
    expect(namesSatisfied(['"odd name"', 'b'], '"odd name", b')).toBe(true);
  });

  it('refuses a partial answer, which is the whole point', () => {
    expect(namesSatisfied(['a', 'b'], 'a')).toBe(false);
    expect(namesSatisfied(['legacy_flag'], 'legacy')).toBe(false);
    expect(namesSatisfied(['legacy_flag'], '')).toBe(false);
  });

  it('refuses the table when the column was asked for', () => {
    // D-468's reason for asking for the column: the table is the one thing the
    // user already knows they are looking at, so typing it confirms nothing.
    expect(namesSatisfied(['legacy_flag'], 'public.posts')).toBe(false);
  });

  it('is case sensitive, because an identifier is', () => {
    // `"Posts"` and `posts` are different columns in Postgres, and a
    // confirmation that blurs them is a confirmation that can be satisfied by
    // typing the wrong thing.
    expect(namesSatisfied(['posts'], 'Posts')).toBe(false);
  });

  it('is satisfied when nothing is required', () => {
    // Every safe operation, which must not be gated by an empty field.
    expect(namesSatisfied([], '')).toBe(true);
  });
});
