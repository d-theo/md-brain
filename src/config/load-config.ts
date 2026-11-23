import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeError } from '../domain/errors.js';
import { ConfigError, defaultPathContext, KnowledgeBaseConfig } from './project-config.js';

export const CONFIG_ENV_VAR = 'MD_BRAIN_CONFIG';
export const DEFAULT_CONFIG_FILE = 'config.yaml';

export function resolveConfigPath(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  return resolve(explicit ?? env[CONFIG_ENV_VAR] ?? DEFAULT_CONFIG_FILE);
}

export function loadConfig(configPath: string): KnowledgeBaseConfig {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read configuration "${configPath}": ${describeError(error)}`);
  }
  return KnowledgeBaseConfig.parse(text, defaultPathContext(configPath));
}
