import { useState, type ReactNode } from 'react';
import type { Tone } from '../lib/deployState';
import { prettyJson } from '../lib/format';

export type { Tone };

const TONE_ICON: Record<Tone, string> = {
  success: '✓',
  warning: '!',
  danger: '✕',
  info: '…',
  muted: '–',
};

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      <span className="badge-icon" aria-hidden>{TONE_ICON[tone]}</span>
      {children}
    </span>
  );
}

/** 해시·digest·커밋·run_id. 앞부분만 보이고 클릭하면 전체 복사. */
export function Hash({ value, length = 12, className }: { value: string | null | undefined; length?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="mono muted">—</span>;
  const prefix = value.startsWith('sha256:') ? 'sha256:' : '';
  const body = value.slice(prefix.length);
  const short = body.length > length ? `${prefix}${body.slice(0, length)}…` : value;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      window.prompt('복사', value);
    }
  };
  return (
    <button type="button" className={`hash ${className ?? ''}`} title={`${value}\n클릭하면 복사`} onClick={copy}>
      <span className="mono">{short}</span>
      <span className="hash-copy">{copied ? '복사됨' : '복사'}</span>
    </button>
  );
}

export function Kv({ items, columns = 2 }: { items: Array<[string, ReactNode] | null | false | undefined>; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={`kv kv-${columns}`}>
      {items.filter((item): item is [string, ReactNode] => Boolean(item)).map(([label, value]) => (
        <div className="kv-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Notice({ tone, title, children }: { tone: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'danger' || tone === 'warning' ? 'alert' : undefined}>
      <span className="notice-icon" aria-hidden>{TONE_ICON[tone]}</span>
      <div>
        {title && <div className="notice-title">{title}</div>}
        {children && <div className="notice-body">{children}</div>}
      </div>
    </div>
  );
}

export function Collapsible({ title, summary, defaultOpen = false, children }: { title: ReactNode; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="collapsible" open={defaultOpen}>
      <summary>
        <span className="collapsible-title">{title}</span>
        {summary && <span className="collapsible-summary">{summary}</span>}
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}

export function JsonBlock({ value, raw }: { value?: unknown; raw?: string }) {
  return <pre className="code">{raw ?? prettyJson(value)}</pre>;
}

export function Bilingual({ ko, ja }: { ko: ReactNode; ja?: string | null }) {
  return (
    <div className="bilingual">
      <div className="bilingual-ko">{ko}</div>
      {ja && <div className="bilingual-ja" lang="ja">{ja}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** 원본 JSON 등 소음이 되는 내용을 기본 숨김으로 둔다. */
export function RawToggle({ label = '원본 보기', children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="raw-toggle">
      <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '원본 닫기' : label}
      </button>
      {open && <div className="raw-body">{children}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" aria-selected={tab.id === value} className={`tab ${tab.id === value ? 'tab-active' : ''}`} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function DemoBadge() {
  return (
    <span className="demo-badge" title="실제 백엔드가 아니라 mock 데이터입니다">
      DEMO DATA
    </span>
  );
}
