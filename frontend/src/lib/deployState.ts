import type { DeployResult } from '../api/contracts';
import type { StageExecution } from '../api/types';
import { targetLabel } from './format';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

export interface DeployDisplay {
  tone: Tone;
  /** 한 줄 결론 */
  title: string;
  /** 부가 설명 */
  details: string[];
  /** decision 과 routing.result 를 따로 보여주기 위한 배지 */
  decisionLabel: string | null;
  routingLabel: string | null;
  routingTone: Tone | null;
}

/**
 * deploy 단계 + deploy_result 로 화면 상태를 정한다.
 * decision 과 routing.result 는 반드시 따로 읽는다. activated 라도 routing.result=error 면 성공이 아니다.
 */
export function deriveDeployDisplay(stage: StageExecution | undefined, result: DeployResult | null | undefined): DeployDisplay {
  if (!stage) {
    return { tone: 'muted', title: '미실행 또는 생략', details: ['deploy 단계 기록이 없음'], decisionLabel: null, routingLabel: null, routingTone: null };
  }
  if (stage.status === 'skipped') {
    return { tone: 'muted', title: '생략됨', details: ['DEPLOY_MODE=off 등으로 배포 단계를 건너뜀. 실제 배포는 일어나지 않음'], decisionLabel: null, routingLabel: null, routingTone: null };
  }
  if (stage.status === 'pending' || stage.status === 'running') {
    return { tone: 'info', title: stage.status === 'running' ? '배포 진행 중' : '배포 대기 중', details: [], decisionLabel: null, routingLabel: null, routingTone: null };
  }
  if (!result) {
    if (stage.status === 'failed') {
      return { tone: 'danger', title: '배포 시작 안 됨', details: [stage.error ?? '원인 미기록', '게이트(검증된 커밋·registry digest·서명 결과) 실패 시 deploy_result 가 만들어지지 않음'], decisionLabel: null, routingLabel: null, routingTone: null };
    }
    return { tone: 'muted', title: '미실행 또는 생략', details: ['deploy_result 산출물이 없음'], decisionLabel: null, routingLabel: null, routingTone: null };
  }

  const routing = result.routing;
  const routingLabel = `routing: ${routing.result}`;
  const routingTone: Tone = routing.result === 'ok' ? 'success' : routing.result === 'error' ? 'danger' : 'muted';
  const decisionLabel = `decision: ${result.decision}`;
  const details: string[] = [];

  switch (result.decision) {
    case 'activated': {
      if (routing.result === 'ok') {
        details.push(`트래픽 → ${targetLabel(routing.kind)} (route revision ${routing.revision ?? '?'})`);
        if (routing.standby_target_id) details.push(`standby ${routing.standby_enabled ? '활성' : '비활성'}`);
        return { tone: 'success', title: '배포 완료, 트래픽 전환됨', details, decisionLabel, routingLabel, routingTone };
      }
      if (routing.result === 'error') {
        // main 2cca2c3 부터 routing 실패는 rolled_back / error 로 기록된다. 이 가지는 구 버전 결과를 위한 방어용 fallback.
        details.push(`전환 실패 원인: ${routing.error ?? '미기록'}`);
        details.push('새 버전은 떠 있지만 route 는 이전 target 을 가리킴. 수동 route 변경이 필요함');
        return { tone: 'danger', title: '새 버전은 떴지만 트래픽 전환 실패', details, decisionLabel, routingLabel, routingTone };
      }
      details.push(`route 를 바꾸지 않음 (${routing.reason ?? '이유 미기록'})`);
      return { tone: 'warning', title: '활성화됐지만 트래픽 전환 안 함', details, decisionLabel, routingLabel, routingTone };
    }
    case 'held': {
      const failedChecks = result.checks.filter((c) => !c.pass).map((c) => targetLabel(c.target));
      const failedCandidates = result.targets.filter((t) => t.phase === 'candidate' && t.result === 'error').map((t) => targetLabel(t.target));
      if (failedChecks.length) details.push(`검사 실패: ${failedChecks.join(', ')}`);
      if (failedCandidates.length) details.push(`후보 기동 실패: ${failedCandidates.join(', ')}`);
      if (result.error) details.push(result.error);
      details.push('후보는 폐기되고 기존 서비스는 계속 동작 중');
      return { tone: 'warning', title: '안전하게 보류됨. 새 버전의 후보 검사가 실패해 트래픽을 전환하지 않았습니다', details, decisionLabel, routingLabel, routingTone };
    }
    case 'rolled_back': {
      // 되돌린 대상은 serving 에 남는다 (Cloud Run 은 revision, On-Prem 은 컨테이너)
      for (const step of result.targets.filter((t) => t.phase === 'rollback' && t.result === 'ok')) {
        details.push(step.serving ? `${targetLabel(step.target)} 을 ${step.serving} 로 되돌림` : `${targetLabel(step.target)} 을 이전 버전으로 되돌림`);
      }
      if (result.error) details.push(result.error);
      return { tone: 'warning', title: '이전 버전으로 복구됨', details, decisionLabel, routingLabel, routingTone };
    }
    case 'error': {
      if (result.error) details.push(result.error);
      const rollbackFailed = result.targets.some((t) => t.phase === 'rollback' && t.result === 'error');
      const cloudActivated = result.targets.some((t) => t.target === 'cloud_run' && t.phase === 'activate' && t.result === 'ok');
      if (rollbackFailed || cloudActivated) details.push('Cloud Run이 새 버전을 서빙 중일 수 있음. 수동 확인 필요');
      if (!result.signature) details.push('서명 검증 전에 중단됨');
      return { tone: 'danger', title: '오류', details, decisionLabel, routingLabel, routingTone };
    }
  }
}
