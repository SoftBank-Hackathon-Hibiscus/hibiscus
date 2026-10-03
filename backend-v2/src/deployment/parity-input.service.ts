import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { BackendConfig } from '../config/configs/backend.config.js';

const absoluteFile = z
  .string()
  .min(1)
  .refine(isAbsolute, 'An absolute path is required');

const parityInputSchema = z
  .object({
    record: absoluteFile,
    noise: absoluteFile,
    after: z.array(z.number().int().positive()).default([]),
    health_path: z
      .string()
      .regex(/^\/\S*$/)
      .default('/healthz'),
    health_timeout: z.number().positive().default(30),
    // Prebuilt runs use <directory>/<deployment.id>/build_manifest.json.
    build_manifest_directory: absoluteFile.optional(),
  })
  .strict();

export type ParityInput = z.infer<typeof parityInputSchema>;

@Injectable()
export class ParityInputService {
  constructor(private readonly config: ConfigService<BackendConfig, true>) {}

  assertRegistrationReady(slug: string): void {
    if (
      this.config.get('backend.parityTestMode', { infer: true }) !== 'registry'
    ) {
      return;
    }
    try {
      this.get(slug);
    } catch {
      throw new UnprocessableEntityException(
        'Registry parity inputs are not configured for this application slug',
      );
    }
  }

  get(slug: string): ParityInput {
    const inputFile = this.config.get('backend.parityInputsFile', {
      infer: true,
    });
    if (!isAbsolute(inputFile)) {
      throw new Error('PARITY_INPUTS_FILE must be an absolute path');
    }
    const inputs = z
      .record(z.string(), parityInputSchema)
      .parse(JSON.parse(readFileSync(inputFile, 'utf8')));
    const input = inputs[slug];
    if (!input) {
      throw new Error('Parity inputs are missing for this application slug');
    }
    for (const file of [input.record, input.noise]) {
      if (!existsSync(file)) {
        throw new Error('Parity baseline file is missing');
      }
    }
    return input;
  }
}
