export interface SecretRule {
  readonly name: string;
  readonly pattern: RegExp;
}

/** Placeholders (`${X}`, `{{X}}`, `<X>`, `%X%`, `****`) are not credentials. */
const PLACEHOLDER = /^(\$|\{\{|<|%|\*+$|x+$|changeme$|password$|secret$)/i;

export const SECRET_RULES: readonly SecretRule[] = [
  { name: 'gitlab-token', pattern: /\bglpat-[0-9A-Za-z_-]{20,}/ },
  { name: 'github-token', pattern: /\bgh[pousr]_[0-9A-Za-z]{36,}/ },
  { name: 'slack-token', pattern: /\bxox[abposr]-[0-9A-Za-z-]{10,}/ },
  { name: 'aws-access-key-id', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    name: 'aws-secret-access-key',
    pattern: /aws_secret_access_key\s*[:=]\s*['"]?[0-9A-Za-z/+]{40}\b/i,
  },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const URL_CREDENTIALS =
  /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/'"`]+):([^\s@/'"`]+)@(\[[^\]\s]*\]|[^\s/:'"`?#]*)/gi;
/** Credentials pointing at the local machine are development defaults, not secrets. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;
const PASSWORD_ASSIGNMENT =
  /\b(?:password|passwd|pwd|secret|client_secret|api_key|apikey)\s*[:=]\s*['"]([^'"\s]{8,})['"]/gi;

export interface SecretFinding {
  /** Rule names only: secret values are never returned nor logged. */
  readonly rules: readonly string[];
}

function hasRealValue(
  content: string,
  pattern: RegExp,
  group: number,
  isAllowed: (match: RegExpExecArray) => boolean = () => false,
): boolean {
  for (const match of content.matchAll(pattern)) {
    const value = match[group] ?? '';
    if (!PLACEHOLDER.test(value) && !isAllowed(match)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the rules matched by the content, or null when it looks clean. A positive file is
 * skipped entirely by the indexer. Heuristic by design: path exclusions are the first line.
 */
export function detectSecrets(content: string): SecretFinding | null {
  const rules = SECRET_RULES.filter((rule) => rule.pattern.test(content)).map((rule) => rule.name);
  if (hasRealValue(content, URL_CREDENTIALS, 2, (match) => LOCAL_HOST.test(match[3] ?? ''))) {
    rules.push('url-credentials');
  }
  if (hasRealValue(content, PASSWORD_ASSIGNMENT, 1)) {
    rules.push('password-assignment');
  }
  return rules.length === 0 ? null : { rules };
}
