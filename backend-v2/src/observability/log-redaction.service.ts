import { Injectable } from '@nestjs/common';
@Injectable()
export class LogRedactionService {
  redact(message: string, secrets: string[]): string {
    let text = message;
    // Longest first so overlapping credentials cannot expose suffixes.
    for (const value of [...new Set(secrets)]
      .filter((v) => v.length >= 4)
      .sort((a, b) => b.length - a.length))
      text = text.split(value).join('[REDACTED]');
    return text
      .replace(
        /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi,
        '$1[REDACTED]',
      )
      .replace(
        /((?:password|secret|token|access_key|api_key)\s*["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi,
        '$1[REDACTED]',
      )
      .replace(/(\w+:\/\/[^\s:/]+:)[^@\s]+@/g, '$1[REDACTED]@')
      .slice(0, 4096);
  }
}
