import { Check, Copy, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Tone } from '../lib/deployState';
import { useLang } from '../lib/i18n';
import { prettyJson } from '../lib/format';

export type { Tone };

/** 작은 알약 배지. 상태를 나타내는 유일한 색 요소로 쓴다. */
export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      <span className="pill-dot" aria-hidden />
      {children}
    </span>
  );
}

/** 파스텔 네모 위의 아이콘. 카드마다 하나만. */
export function IconTile({ icon: Icon, tone = 'accent', size = 40 }: { icon: LucideIcon; tone?: Tone | 'accent'; size?: number }) {
  return (
    <span className={`tile tile-${tone}`} style={{ width: size, height: size }} aria-hidden>
      <Icon size={Math.round(size * 0.5)} strokeWidth={2} />
    </span>
  );
}

/** 해시·digest·커밋·URL. 앞부분만 보이고 마우스를 올리면 복사 아이콘, 누르면 전체 복사. */
export function Hash({ value, length = 12, full = false }: { value: string | null | undefined; length?: number; full?: boolean }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="mono muted">{t('none')}</span>;
  const prefix = value.startsWith('sha256:') ? 'sha256:' : '';
  const body = value.slice(prefix.length);
  const short = full || body.length <= length ? value : `${prefix}${body.slice(0, length)}…`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      window.prompt(t('copy'), value);
    }
  };
  return (
    <button type="button" className="hash" title={value} onClick={copy} aria-label={`${t('copy')} ${value}`}>
      <span className="mono">{short}</span>
      <span className="hash-copy" aria-hidden>{copied ? <Check size={13} /> : <Copy size={13} />}</span>
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

const TONE_ICON: Record<Tone, string> = { success: '✓', warning: '!', danger: '✕', info: '…', muted: '–' };

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

/** "자세히 보기" 버튼으로 여는 영역 */
export function MoreToggle({ children, label }: { children: ReactNode; label?: string }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <div className="more">
      <button type="button" className="btn btn-small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? t('hideDetails') : (label ?? t('details'))}
      </button>
      {open && <div className="more-body">{children}</div>}
    </div>
  );
}

export function RawToggle({ label, children }: { label?: string; children: ReactNode }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <div className="raw-toggle">
      <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? t('hideDetails') : (label ?? t('raw'))}
      </button>
      {open && <div className="raw-body">{children}</div>}
    </div>
  );
}

export function JsonBlock({ value, raw }: { value?: unknown; raw?: string }) {
  return <pre className="code">{raw ?? prettyJson(value)}</pre>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function DemoBadge({ small = false }: { small?: boolean }) {
  return (
    <span className={`demo-badge ${small ? 'demo-badge-small' : ''}`} title="mock data">
      DEMO DATA
    </span>
  );
}

export function PageTitle({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <header className="page-title">
      <div>
        <h1>{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {right && <div className="page-title-right">{right}</div>}
    </header>
  );
}
