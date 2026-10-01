/**
 * parity 인계 묶음을 파일에서 읽어 test_result 로 바꾼다. CLI(src/adapters/cli.ts)와 실행기(src/stage-runner.ts)가 같이 쓴다.
 * 형식 오류와 변환 거부는 모두 CliError 로 알린다.
 */
import { CliError, loadJson, validate } from "../io.js";
import { ParityAdapterError, type ParityAdapterOutput, ParityDiagnosticsSchema, ParityHandoffSchema, adaptParityHandoff } from "./parity.js";

export const HANDOFF_LABEL = "parity 인계 묶음";
export const DIAGNOSTICS_LABEL = "parity 실행 진단";

export function loadParityHandoff(handoffPath: string, diagnosticsPath?: string): ParityAdapterOutput {
  const handoff = validate(ParityHandoffSchema, loadJson(handoffPath, HANDOFF_LABEL), HANDOFF_LABEL, handoffPath);
  const diagnostics =
    diagnosticsPath !== undefined ? validate(ParityDiagnosticsSchema, loadJson(diagnosticsPath, DIAGNOSTICS_LABEL), DIAGNOSTICS_LABEL, diagnosticsPath) : undefined;
  try {
    return adaptParityHandoff(handoff, diagnostics);
  } catch (e) {
    if (e instanceof ParityAdapterError) throw new CliError(`${HANDOFF_LABEL}을 변환할 수 없습니다: ${handoffPath}\n  - ${e.message}`);
    throw e;
  }
}
