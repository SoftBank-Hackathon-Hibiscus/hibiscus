import { LogRedactionService } from '../observability/log-redaction.service.js';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { agentSshEvents } from '../database/schema.js';
import type { AgentSshReportDto } from '../agent/dto/agent-heartbeat.dto.js';
@Injectable()
export class SshConnectionStateService {
  private readonly sessions = new Map<
    string,
    { connectedAt: string; ports: Set<number> }
  >();
  private readonly reports = new Map<
    string,
    { receivedAt: string; report: AgentSshReportDto }
  >();
  constructor(private readonly database: DatabaseService) {}
  connected(agentId: string) {
    this.sessions.set(agentId, {
      connectedAt: new Date().toISOString(),
      ports: new Set(),
    });
    this.event(agentId, 'connected', null, 'SSH session authenticated');
  }
  disconnected(agentId: string, reason: string) {
    this.sessions.delete(agentId);
    this.event(agentId, 'disconnected', null, reason);
  }
  forward(agentId: string, port: number, active: boolean) {
    const session = this.sessions.get(agentId);
    if (active) session?.ports.add(port);
    else session?.ports.delete(port);
    this.event(
      agentId,
      active ? 'forward_opened' : 'forward_closed',
      null,
      active ? 'Forward listening' : 'Forward removed',
      port,
    );
  }
  event(
    agentId: string,
    kind: string,
    code: string | null,
    message: string,
    port?: number,
  ) {
    this.database.db.transaction((tx) => {
      tx.insert(agentSshEvents)
        .values({
          id: randomUUID(),
          agentId,
          kind,
          code,
          message: new LogRedactionService().redact(message, []).slice(0, 500),
          port: port ?? null,
          createdAt: new Date().toISOString(),
        })
        .run();
      tx.delete(agentSshEvents)
        .where(
          and(
            eq(agentSshEvents.agentId, agentId),
            sql`${agentSshEvents.id} NOT IN (SELECT id FROM agent_ssh_events WHERE agent_id = ${agentId} ORDER BY created_at DESC, rowid DESC LIMIT 100)`,
          ),
        )
        .run();
    });
  }
  report(agentId: string, report: AgentSshReportDto) {
    report = Object.assign(
      {},
      report,
      report.last_error
        ? {
            last_error: new LogRedactionService()
              .redact(report.last_error, [])
              .slice(0, 500),
          }
        : {},
    );
    const previous = this.reports.get(agentId)?.report;
    this.reports.set(agentId, { receivedAt: new Date().toISOString(), report });
    if (
      previous?.state !== report.state ||
      previous?.last_error !== report.last_error ||
      previous?.retry_count !== report.retry_count
    ) {
      this.event(
        agentId,
        'agent_' + report.state,
        report.last_error_code ?? null,
        report.last_error ?? report.state,
      );
    }
  }
  snapshot(agentId: string) {
    const session = this.sessions.get(agentId);
    const report = this.reports.get(agentId);
    const fresh = report && Date.now() - Date.parse(report.receivedAt) < 30000;
    const events = this.database.db
      .select()
      .from(agentSshEvents)
      .where(eq(agentSshEvents.agentId, agentId))
      .orderBy(desc(agentSshEvents.createdAt), sql`rowid DESC`)
      .limit(100)
      .all();
    return {
      connected: !!session,
      connected_at: session?.connectedAt ?? null,
      uptime_seconds: session
        ? Math.floor((Date.now() - Date.parse(session.connectedAt)) / 1000)
        : 0,
      bound_ports: session ? [...session.ports] : [],
      report: fresh ? report.report : null,
      report_received_at: report?.receivedAt ?? null,
      report_stale: !!report && !fresh,
      events,
    };
  }
}
