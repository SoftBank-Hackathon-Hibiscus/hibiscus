import { describe, expect, it } from 'vitest';
import { LogRedactionService } from '../log-redaction.service.js';
describe('runtime log redaction', () => {
  it('masks plain known secrets before truncation and common credential formats', () => {
    const service = new LogRedactionService();
    const text = service.redact(
      'abcd-long-secret mysql://user:password@db authorization: Bearer abc123 password=pass123 token="abcdef"',
      ['abcd-long', 'abcd-long-secret'],
    );
    expect(text).not.toContain('long-secret');
    expect(text).not.toContain('pass123');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('abcdef');
    expect(text).toContain('[REDACTED]');
  });
});
