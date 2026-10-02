import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';

export class ContractValidator {
  private readonly cache = new Map<string, ValidateFunction>();

  violation(
    schemaPath: string,
    data: unknown,
    label: string,
  ): string | undefined {
    let validate = this.cache.get(schemaPath);
    if (!validate) {
      try {
        const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
        validate = new Ajv2020({ strict: false, allErrors: true }).compile(
          schema,
        );
        this.cache.set(schemaPath, validate);
      } catch {
        return `Unable to load contract schema for ${label}`;
      }
    }
    if (validate(data)) return undefined;
    const issue = validate.errors?.[0];
    return `Invalid ${label} contract at ${issue?.instancePath || '(root)'}: ${issue?.message || 'Unknown validation error'}`;
  }
}
