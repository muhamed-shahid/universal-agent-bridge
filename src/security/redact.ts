/**
 * Secret redaction for anything UAB stores or returns: agent output, logs, git diffs and test
 * output. Patterns cover common credential formats; in addition, the values of environment
 * variables whose names look secret are replaced wherever they appear.
 */

export const REDACTED = '[REDACTED]';

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\buab_st_[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** `key = value` style assignments where the key name looks secret. Keeps the key. */
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi;
/** Values that are code, not secrets: `process.env.PASSWORD`, `config.auth.token`. */
const CODE_REFERENCE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+;?$/;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi;

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Redactor {
  readonly #literals: RegExp | undefined;

  /** `env`: environment whose secret-looking values are redacted literally. */
  constructor(env: Readonly<Record<string, string | undefined>> = {}) {
    const values = Object.entries(env)
      .filter(
        ([name, value]) => SECRET_ENV_NAME.test(name) && value !== undefined && value.length >= 8,
      )
      .map(([, value]) => value as string)
      .sort((a, b) => b.length - a.length);
    this.#literals =
      values.length === 0 ? undefined : new RegExp(values.map(escapeRegExp).join('|'), 'g');
  }

  redact(text: string): string {
    let out = text;
    if (this.#literals !== undefined) out = out.replace(this.#literals, REDACTED);
    for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
    out = out.replace(BEARER, `$1 ${REDACTED}`);
    out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
    out = out.replace(ASSIGNMENT, (match, key: string, sep: string, value: string) =>
      value === REDACTED || /^\$\{?[A-Z_]+\}?$/.test(value) || CODE_REFERENCE.test(value)
        ? match
        : `${key}${sep}${REDACTED}`,
    );
    return out;
  }
}

/** Files whose contents UAB never returns (diffs, structure listings show only the name). */
const SENSITIVE_FILE = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.envrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml)$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
];

export function isSensitivePath(relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, '/');
  if (/^\.env\.(example|sample|template)$/i.test(p.split('/').pop() ?? '')) return false;
  return SENSITIVE_FILE.some((r) => r.test(p));
}
