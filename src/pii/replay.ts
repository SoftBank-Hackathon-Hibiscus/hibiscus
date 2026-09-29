/**
 * 재생 판정기: recordings/ 에 저장된 LLM 응답을 그대로 사용한다.
 *
 * LlmClassifier 와 같은 경로(휴리스틱 → 애매한 칼럼만 → 응답 병합)를 타되,
 * 실제 호출 대신 파일의 response 를 돌려준다. 그래서 데모·테스트가 네트워크 없이 결정적으로 돈다.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Classifier } from "./classifier.js";
import { LlmClassifier, LlmResponseSchema } from "./llm.js";

export const RecordingSchema = z.object({
  recorded_at: z.string().optional(),
  /** 어떤 모델로 호출했는지. CLI --record 가 채운다 */
  model: z.string().optional(),
  note: z.string().optional(),
  request: z.object({ system: z.string(), user: z.string() }).optional(),
  response: LlmResponseSchema,
});
export type Recording = z.infer<typeof RecordingSchema>;

export function loadRecording(path: string): Recording {
  return RecordingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export class ReplayClassifier extends LlmClassifier {
  constructor(base: Classifier, recording: Recording) {
    super({ base, call: async () => recording.response, source: "replay" });
  }
}
