import { NotFoundException } from '@nestjs/common';
import type { CreateRoutingTargetDto } from '../../routing/dto/routing.dto.js';
import type { RoutingService } from '../../routing/routing.service.js';
import type {
  RoutingPort,
  RoutingTargetInput,
} from '../types/deploy-result.type.js';

/**
 * 태현님 RoutingService 로 이번 배포의 대상을 등록하고 대표 경로를 바꾼다.
 * 다시 실행돼도 같은 배포·종류의 대상은 새로 만들지 않는다.
 */
export class RoutingAdapter implements RoutingPort {
  constructor(private readonly routing: RoutingService) {}

  ensureTarget(input: RoutingTargetInput): string {
    const existing = this.routing
      .listTargets(input.applicationId)
      .find(
        ({ target }) =>
          target.deploymentId === input.deploymentId &&
          target.kind === input.kind &&
          (input.kind !== 'onprem' || target.agentId === input.agentId),
      );
    if (existing) return existing.target.id;
    const dto = {
      deployment_id: input.deploymentId,
      kind: input.kind,
      enabled: input.enabled,
      ...(input.kind === 'onprem'
        ? { agent_id: input.agentId, local_port: input.localPort }
        : { url: input.url }),
    } as CreateRoutingTargetDto;
    return this.routing.createTarget(input.applicationId, dto).id;
  }

  switchTo(
    applicationId: string,
    targetId: string,
    changedBy: string,
    reason: string,
  ): number {
    let current: { revision: number; targetId: string } | undefined;
    try {
      const route = this.routing.getRoute(applicationId);
      current = { revision: route.revision, targetId: route.target.id };
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
    if (current?.targetId === targetId) return current.revision;
    return this.routing.changeRoute(
      applicationId,
      {
        target_id: targetId,
        expected_revision: current?.revision ?? 0,
        reason,
      },
      changedBy,
    ).revision;
  }
}
