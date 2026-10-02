import type { ReactNode } from "react";
import type { IconName } from "../lib/icons";
import type { Tone } from "../lib/deployStatus";
import { Icon } from "./Icon";

export function Pill({ tone, icon, children }: { tone: Tone; icon?: IconName; children: ReactNode }) {
  return (
    <span className={`pill tone-${tone}`}>
      {icon && <Icon name={icon} size={13} />}
      <span>{children}</span>
    </span>
  );
}

export function Card({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || aside) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {aside && <div className="card-aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Fields({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="fields">
      {items.map(([label, value], index) => (
        <div key={index} className="field">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono" title={title}>
      {children}
    </code>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorNote({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <div className="banner tone-danger" role="alert">
      <Icon name="alert" />
      <span>불러오기 실패: {error.message}</span>
    </div>
  );
}

export function Loading() {
  return (
    <div className="loading">
      <Icon name="spinner" /> 불러오는 중
    </div>
  );
}

export function Bool({ value, yes, no }: { value: boolean; yes: string; no: string }) {
  return value ? <Pill tone="success" icon="check">{yes}</Pill> : <Pill tone="neutral" icon="minus">{no}</Pill>;
}
