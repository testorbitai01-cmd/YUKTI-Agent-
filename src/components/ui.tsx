/** UI primitives mirroring Test Orbit's admin components (Card, PageHeader, StatCard, Badge, EmptyState). */
import type { HTMLAttributes, ReactNode } from 'react';
import { ArrowLeft, type LucideIcon } from 'lucide-react';
import type { Tone } from '../status';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Card({ className, ...rest }: HTMLAttributes<HTMLElement> & { as?: never }) {
  return <section className={cx('card', className)} {...rest} />;
}

export function CardHeader({ icon: Icon, title, description, actions, tone = 'brand' }: { icon?: LucideIcon; title: ReactNode; description?: ReactNode; actions?: ReactNode; tone?: Tone }) {
  return (
    <div className="card-header">
      <div className="row" style={{ alignItems: 'flex-start', gap: 12, minWidth: 0 }}>
        {Icon && (
          <span className={`icon-tile ${tone}`} aria-hidden>
            <Icon size={18} />
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { label: string; href: string } }) {
  return (
    <div style={{ marginBottom: 24 }}>
      {back && (
        <a className="back" href={back.href}>
          <ArrowLeft size={14} /> {back.label}
        </a>
      )}
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div style={{ minWidth: 0 }}>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="row wrap">{actions}</div>}
      </div>
    </div>
  );
}

export function StatCard({ label, value, hint, icon: Icon, tone = 'neutral' }: { label: string; value: ReactNode; hint?: ReactNode; icon: LucideIcon; tone?: Tone }) {
  return (
    <div className="card stat">
      <div style={{ minWidth: 0 }}>
        <div className="k">{label}</div>
        <div className="v">{value}</div>
        {hint && <div className="h">{hint}</div>}
      </div>
      <span className={`icon-tile ${tone}`} aria-hidden>
        <Icon size={18} />
      </span>
    </div>
  );
}

export function Badge({ tone = 'neutral', icon: Icon, spin, children, title }: { tone?: Tone; icon?: LucideIcon; spin?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {Icon && <Icon size={12} className={spin ? 'spin' : undefined} />}
      {children}
    </span>
  );
}

/** Run status pill (spinner while running). */
export function StatusBadge({ meta, running }: { meta: { label: string; tone: Tone; icon: LucideIcon }; running?: boolean }) {
  return (
    <Badge tone={meta.tone} icon={meta.icon} spin={running}>
      {meta.label}
    </Badge>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="icon-tile brand" aria-hidden>
        <Icon size={22} />
      </span>
      <h3>{title}</h3>
      {description && <p style={{ maxWidth: 420 }}>{description}</p>}
      {action}
    </div>
  );
}
