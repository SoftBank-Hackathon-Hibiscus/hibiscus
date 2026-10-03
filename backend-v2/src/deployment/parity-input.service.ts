import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PARITY_DIRECTORY = join('.hibiscus', 'parity');
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_NOISE_BYTES = 256 * 1024;

export interface ParityInput {
  record: string;
  noise: string;
  hash: string;
}

@Injectable()
export class ParityInputService {
  fromSource(sourcePath: string): ParityInput | undefined {
    const directory = join(sourcePath, PARITY_DIRECTORY);
    const record = join(directory, 'session.jsonl');
    const noise = join(directory, 'noise.json');
    const hasRecord = existsSync(record);
    const hasNoise = existsSync(noise);
    if (!hasRecord && !hasNoise) return undefined;
    if (!hasRecord || !hasNoise) {
      throw new Error(
        'Both .hibiscus/parity/session.jsonl and noise.json are required',
      );
    }

    const recordContent = this.readRegularFile(record, MAX_RECORD_BYTES);
    const noiseContent = this.readRegularFile(noise, MAX_NOISE_BYTES);
    if (!recordContent.toString('utf8').trim()) {
      throw new Error('Parity session.jsonl must not be empty');
    }
    try {
      JSON.parse(noiseContent.toString('utf8'));
    } catch {
      throw new Error('Parity noise.json is not valid JSON');
    }
    for (const line of recordContent.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
      } catch {
        throw new Error('Parity session.jsonl contains invalid JSON');
      }
    }

    const hash = createHash('sha256')
      .update('session.jsonl\0')
      .update(recordContent)
      .update('\0noise.json\0')
      .update(noiseContent)
      .digest('hex');
    return { record, noise, hash };
  }

  private readRegularFile(path: string, maximumBytes: number): Buffer {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Parity inputs must be regular files');
    }
    if (stat.size > maximumBytes) {
      throw new Error('Parity input exceeds the size limit');
    }
    return readFileSync(path);
  }
}
