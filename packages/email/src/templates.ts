/**
 * The five V1 templates, rendered from Steadhold-controlled layouts (D-116).
 *
 * ## The restriction is the feature
 *
 * A project may override the *text* of a subject and a body. It may not supply
 * HTML, and it may not supply a link. Every URL in an auth mail is built by us
 * from the project's already-validated redirect (P4c). That is what stops this
 * being a phishing kit: without it, anyone who can create a free project can make
 * a reputable domain send arbitrary content and arbitrary links to any address
 * they choose. Template freedom arrives with custom SMTP (D-117), where the
 * reputation at stake is the project's own.
 *
 * ## Variable names are GoTrue's
 *
 * `{{ .ConfirmationURL }}`, not `{{confirmation_url}}`, because a customer
 * migrating from Supabase brings templates and the point of D-011's portability
 * argument is that they should not have to rewrite them.
 */

export const TEMPLATE_NAMES = [
  'confirmation', 'recovery', 'account_exists_notice',
  // Reserved, unbuilt, and listed so the type is the doc's set rather than
  // whatever is implemented this week: nothing emits these until their flows
  // exist (email change is Flow 9, the notice is Flow 7 step 5).
  'email_change_current', 'email_change_new', 'password_changed_notice',
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export interface TemplateVariables {
  ConfirmationURL?: string | undefined;
  Token?: string | undefined;
  SiteURL?: string | undefined;
  Email?: string | undefined;
  NewEmail?: string | undefined;
  ProjectName?: string | undefined;
}

/**
 * HTML-escape. Applied to every interpolated value, without exception.
 *
 * The values here are attacker-controlled in the cases that matter: `Email` is
 * whatever a signup form was given, and `ProjectName` is whatever a customer
 * typed. `'` and `"` are escaped as well as the three obvious ones, because an
 * interpolation inside an attribute (`href`, `alt`) is a different injection
 * point from one in text, and this function does not know which it is in.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const VARIABLE = /\{\{\s*\.([A-Za-z]+)\s*\}\}/g;

export class TemplateError extends Error {}

/**
 * Interpolate `{{ .Name }}` placeholders.
 *
 * An unknown variable **throws** rather than rendering empty. The doc wants that
 * caught at save time in the dashboard, which does not exist yet — so catching it
 * at render time is the fallback, and it is far better than the alternative: a
 * recovery mail whose only link silently renders as the empty string, which
 * looks like a broken product and is unreportable by the user who received it.
 */
export function interpolate(
  body: string, vars: TemplateVariables, escape: (v: string) => string,
): string {
  return body.replace(VARIABLE, (_match, name: string) => {
    if (!(name in vars)) {
      throw new TemplateError(
        `template variable {{ .${name} }} is not one this template provides ` +
        `(available: ${Object.keys(vars).join(', ')})`);
    }
    const value = vars[name as keyof TemplateVariables];
    if (value === undefined) {
      throw new TemplateError(
        `template variable {{ .${name} }} has no value for this message`);
    }
    return escape(value);
  });
}

export interface TemplateSource {
  subject: string;
  /** Paragraphs. Rendered as `<p>` in HTML and blank-line-separated in text. */
  body: string[];
  /** The label on the button, when the template has an action link. */
  action?: string | undefined;
}

/**
 * The defaults. Deliberately plain prose, no marketing, no images.
 *
 * Every one of those is a deliverability decision rather than a style
 * preference: images mean a remote-content fetch that most clients block and
 * every spam filter notices, and enthusiastic copy in a transactional mail is
 * what a bulk filter is trained on. A verification mail that reads like a receipt
 * lands in the inbox.
 */
export const DEFAULT_TEMPLATES: Record<TemplateName, TemplateSource> = {
  confirmation: {
    subject: 'Confirm your email address',
    body: [
      'Confirm {{ .Email }} to finish setting up your account on {{ .ProjectName }}.',
      'This link can only be used once, and expires in 24 hours.',
      'If you did not sign up, you can ignore this message.',
    ],
    action: 'Confirm email address',
  },
  recovery: {
    subject: 'Reset your password',
    body: [
      'Someone asked to reset the password for {{ .Email }} on {{ .ProjectName }}.',
      'This link can only be used once, and expires in 1 hour.',
      // Not "if this was not you, ignore this" alone: telling the recipient what
      // *did not* happen is what makes an unexpected reset mail non-alarming and
      // still actionable.
      'If it was not you, no change has been made and you can ignore this message.',
    ],
    action: 'Choose a new password',
  },
  account_exists_notice: {
    subject: 'Someone tried to sign up with your email address',
    body: [
      'Someone tried to create an account on {{ .ProjectName }} using {{ .Email }}, '
        + 'which already has one.',
      // No link, and that is the point: this mail is triggered by an anonymous
      // stranger, so a password-reset link in it would be a reset anybody could
      // send to anybody. If it *was* the account owner who forgot, they can ask
      // for a reset themselves.
      'No new account was created and nothing has changed. If you have forgotten '
        + 'your password, you can reset it from the sign-in page.',
    ],
  },
  email_change_current: {
    subject: 'Confirm your new email address',
    body: [
      'A request was made to change the email address on your {{ .ProjectName }} '
        + 'account from {{ .Email }} to {{ .NewEmail }}.',
      'Confirm below if you made this request. The change only takes effect once '
        + 'both addresses have confirmed it.',
    ],
    action: 'Confirm this change',
  },
  email_change_new: {
    subject: 'Confirm your email address',
    body: [
      'Confirm {{ .NewEmail }} as the new email address for your '
        + '{{ .ProjectName }} account.',
      'The change only takes effect once both the old and the new address have '
        + 'confirmed it.',
    ],
    action: 'Confirm email address',
  },
  password_changed_notice: {
    subject: 'Your password was changed',
    body: [
      'The password for {{ .Email }} on {{ .ProjectName }} was just changed.',
      // The whole purpose of this mail: it is the tripwire that tells the real
      // owner an attacker completed a reset.
      'If you did not do this, someone else has access to your account. Reset '
        + 'your password from the sign-in page immediately.',
    ],
  },
};

/**
 * The HTML layout. One table, inline styles, no external anything.
 *
 * Inline styles because every mail client strips `<style>` blocks to some degree
 * and Outlook's is the worst; a table because CSS layout in mail is still not
 * reliable. This is ugly by the standards of a web page and is the shape that
 * renders the same in Gmail, Outlook and Apple Mail.
 */
function layout(parts: { title: string; paragraphs: string[]; action?: { url: string; label: string } | undefined; footer: string }): string {
  // Escaped, including into the `href`. The URL is built by us (P4c's
  // `actionLink`) rather than supplied, so this is not the live injection point
  // the interpolated values are — but it embeds a project-configured redirect,
  // and `&` in an unescaped attribute is already wrong HTML while a `"` would
  // end the attribute and start whatever followed it. An href is a string in
  // markup like any other.
  const href = parts.action ? escapeHtml(parts.action.url) : '';
  const button = parts.action
    ? `<tr><td style="padding:8px 0 24px 0;">
         <a href="${href}" style="background:#1a1a1a;border-radius:6px;color:#ffffff;display:inline-block;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;line-height:1;padding:13px 20px;text-decoration:none;">${parts.action.label}</a>
       </td></tr>
       <tr><td style="color:#6b6b6b;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;padding:0 0 8px 0;">
         Or paste this link into your browser:<br><span style="color:#6b6b6b;word-break:break-all;">${href}</span>
       </td></tr>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${parts.title}</title></head>
<body style="background:#f6f6f4;margin:0;padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 28px 4px 28px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td style="color:#1a1a1a;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:17px;font-weight:600;line-height:24px;padding:0 0 12px 0;">${parts.title}</td></tr>
${parts.paragraphs.map((p) => `<tr><td style="color:#3d3d3d;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;padding:0 0 14px 0;">${p}</td></tr>`).join('\n')}
${button}
<tr><td style="border-top:1px solid #eceae6;color:#8a8a8a;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;padding:16px 0 24px 0;">${parts.footer}</td></tr>
</table></td></tr></table></body></html>`;
}

export interface RenderedEmail { subject: string; html: string; text: string }

/**
 * Render one message, both parts, from one source.
 *
 * Both parts from one source is what keeps them from disagreeing — a text part
 * maintained separately drifts, and the version a text-only client sees is the
 * one nobody proofreads.
 */
export function render(
  name: TemplateName, vars: TemplateVariables,
  override?: Partial<TemplateSource> | undefined,
): RenderedEmail {
  const base = DEFAULT_TEMPLATES[name];
  if (!base) throw new TemplateError(`there is no template named ${name}`);
  const source: TemplateSource = {
    subject: override?.subject ?? base.subject,
    body: override?.body ?? base.body,
    ...(base.action !== undefined ? { action: override?.action ?? base.action } : {}),
  };
  const projectName = vars.ProjectName ?? 'this app';
  const withDefaults: TemplateVariables = { ...vars, ProjectName: projectName };

  // The subject is not HTML, so it is interpolated without HTML escaping — and
  // the SMTP layer header-encodes and strips CR/LF from it, which is the
  // injection that matters for a header.
  const subject = interpolate(source.subject, withDefaults, (v) => v);
  const paragraphs = source.body.map((p) => interpolate(p, withDefaults, escapeHtml));
  const url = vars.ConfirmationURL;
  const footer = `Sent by Steadhold on behalf of ${escapeHtml(projectName)}. `
    + 'You are receiving this because your email address was used on their app.';

  const html = layout({
    title: escapeHtml(subject), paragraphs,
    ...(source.action && url ? { action: { url, label: escapeHtml(source.action) } } : {}),
    footer,
  });

  // Text is interpolated with *no* escaping: `&amp;` in a URL a user is meant to
  // paste is a broken link, and there is no markup here to inject into.
  const textParagraphs = source.body.map((p) => interpolate(p, withDefaults, (v) => v));
  const text = [
    subject, '',
    ...textParagraphs.flatMap((p) => [p, '']),
    ...(source.action && url ? [`${source.action}: ${url}`, ''] : []),
    `Sent by Steadhold on behalf of ${projectName}.`,
  ].join('\n');

  return { subject, html, text };
}
