export {
  EmailSendError,
  type EmailProvider, type OutgoingMessage, type SendResult,
} from './provider.ts';
export { createSmtpProvider, type SmtpConfig } from './smtp.ts';
export {
  render, interpolate, escapeHtml, TemplateError,
  TEMPLATE_NAMES, DEFAULT_TEMPLATES,
  type TemplateName, type TemplateSource, type TemplateVariables, type RenderedEmail,
} from './templates.ts';
export { CAPS, capsFor, type EmailCaps } from './caps.ts';
export { checkAndConsume, type CounterStore, type GateArgs, type GateVerdict } from './gate.ts';
