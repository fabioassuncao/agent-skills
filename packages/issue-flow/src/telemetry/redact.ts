import { trimErrorMessage } from '../core/state-manager.js';

const SECRET = /(?:sk-ant-|sk-|ghp_|gho_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}/g;
const BEARER = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const SENSITIVE_FIELD =
  /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)["']?\s*[:=]\s*)["']?([^"',\s}]+)/gi;
const ENV_ASSIGN =
  /\b(?=[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH))[A-Z][A-Z0-9_]*=([^\s]+)/g;

/** Strip credentials from a message that will be persisted. */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET, '[redacted]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(SENSITIVE_FIELD, '$1[redacted]')
    .replace(
      ENV_ASSIGN,
      (match, _value: string) => `${match.slice(0, match.indexOf('='))}=[redacted]`,
    );
}

/** Sanitize a failure message: secrets out, then the existing 8-line cap. */
export function redactFailureMessage(message: string): string {
  return trimErrorMessage(redactSecrets(message));
}
