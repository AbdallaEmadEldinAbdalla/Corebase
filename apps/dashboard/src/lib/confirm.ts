/**
 * Has the user typed the names a destructive statement asks for?
 *
 * A module of its own for one reason: this predicate decides whether a
 * confirmation can be satisfied *at all*. Get it wrong and the confirm button
 * never enables, the user has typed the right thing, and the dialog looks
 * broken with nothing on screen explaining why. It is also the kind of rule that
 * reads as obviously correct and has three edge cases.
 *
 * It is deliberately **not** in `@steadhold/sql-guard`. The guard is
 * authoritative about which names are required (D-468); this is about how a
 * human's typing maps onto them, and the request carries the *names* rather than
 * the typed text — so the server never runs this and there is no skew to worry
 * about. The one place client and server must agree is the spelling of the names
 * themselves, which is why that normalisation lives in the guard and this does
 * not.
 */

/**
 * Every required name present in `typed`, compared exactly.
 *
 * **Separated by whitespace or commas.** The label reads "Type `a` and `b` to
 * confirm", and a great many people will write `a, b` — matching on whitespace
 * alone leaves the button disabled with no explanation.
 *
 * **The names themselves are exact.** This field exists to be evidence that the
 * user read the question, so a fuzzy or case-insensitive match would defeat the
 * point of asking. `"odd name"` keeps its quotes because the guard decided they
 * are load-bearing there, and the user is shown exactly that string.
 *
 * **Order does not matter and extra words are ignored.** Someone who types
 * `drop a and b` has demonstrated they read it; refusing that would be pedantry
 * dressed as safety.
 */
export function namesSatisfied(
  required: readonly string[], typed: string,
): boolean {
  if (required.length === 0) return true;
  /**
   * A quoted name can contain a space — `"odd name"` — so splitting on
   * whitespace first would tear it in half and it could never match. Quoted runs
   * are lifted out before the split and put back as whole tokens.
   */
  const tokens: string[] = [];
  const rest = typed.replace(/"(?:[^"]|"")*"/g, (m) => { tokens.push(m); return ' '; });
  tokens.push(...rest.split(/[\s,]+/).filter(Boolean));
  return required.every((name) => tokens.includes(name));
}
