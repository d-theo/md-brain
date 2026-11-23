import { describe, expect, it } from 'vitest';
import { detectSecrets } from '../../../src/ingestion/secret-guard.js';

// Fake credentials are assembled at runtime so that this file never matches itself.
const fake = (...parts: string[]): string => parts.join('');

describe('secret-guard', () => {
  describe('detectSecrets', () => {
    it.each([
      ['gitlab-token', `url = https://oauth2:${fake('glpat', '-', 'abcdefghij0123456789')}@host`],
      ['github-token', `token: ${fake('ghp', '_', 'a'.repeat(36))}`],
      ['slack-token', `SLACK=${fake('xoxb', '-', '1234567890-abc')}`],
      ['aws-access-key-id', `key = ${fake('AKIA', 'ABCDEFGHIJKLMNOP')}`],
      ['aws-secret-access-key', `aws_secret_access_key = ${'A'.repeat(40)}`],
      ['private-key', fake('-----BEGIN RSA ', 'PRIVATE KEY-----')],
      ['url-credentials', 'postgresql://admin:S3cr3tValue@db.internal:5432/core'],
      ['url-credentials', 'postgresql://admin:S3cr3tValue@postgresql:5432/core'],
      ['url-credentials', 'postgresql://admin:S3cr3tValue@localhost.evil.com/core'],
      ['url-credentials', 'postgresql://a:b@localhost/x postgresql://admin:S3cr3tValue@db/x'],
      ['password-assignment', "password: 'hunter2hunter2'"],
      ['password-assignment', 'client_secret = "abcd1234efgh"'],
    ])('detects %s', (rule, content) => {
      expect(detectSecrets(`before\n${content}\nafter`)?.rules).toContain(rule);
    });

    it.each([
      `postgresql://${'$'}{USER}:${'$'}{PASSWORD}@localhost/db`,
      'postgresql://user:{{fromParameterStore("pg")}}@host/db',
      'https://user:<password>@host',
      "password: '********'",
      "password: 'changeme'",
      "password: '" + '$' + "{DB_PASSWORD}'",
      "password: 'short'",
      'const passwordLabel = "Password";',
      'https://gitlab.example.com/group/repo.git',
      'postgresql://postgres:postgres@localhost:5432/core',
      'postgresql://postgres:postgres@127.0.0.1/core',
      'redis://default:pass@0.0.0.0:6379',
      'postgresql://postgres:postgres@[::1]:5432/core',
      'postgresql://postgres:postgres@LOCALHOST/core',
      '{{fromParameterStore("core-db-password")}}',
    ])('ignores the placeholder or innocuous text %j', (content) => {
      expect(detectSecrets(content)).toBeNull();
    });

    it('reports rule names only, never values', () => {
      const finding = detectSecrets('postgresql://admin:S3cr3tValue@db/core');

      expect(JSON.stringify(finding)).not.toContain('S3cr3tValue');
    });
  });
});
