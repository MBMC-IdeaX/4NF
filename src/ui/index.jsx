// The Bhada UI kit: the handful of parts every screen in the three apps is made
// of. Styles in ui.css, tokens in styles/tokens.css.

import { useEffect, useRef } from 'react';
import Icon from '../portals/shared/Icon';
import './ui.css';

export { Icon };

const cx = (...names) => names.filter(Boolean).join(' ');

export function Button({ variant = 'primary', size, block, busy, icon, children, className, type = 'button', ...rest }) {
  return (
    <button
      type={type}
      className={cx('bx-btn', `bx-btn--${variant}`, size === 'lg' && 'bx-btn--lg', block && 'bx-btn--block', busy && 'bx-btn--busy', !children && 'bx-btn--icon', className)}
      aria-busy={busy || undefined}
      disabled={busy || rest.disabled}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function TopBar({ eyebrow, title, mark, onBack, end }) {
  return (
    <header className="bx-top">
      {onBack ? <Button variant="ghost" icon="back" onClick={onBack} aria-label="Back" /> : null}
      {/* The mark sits beside the title, so every app's bar is one row. */}
      {mark ? <span className="bx-top__mark">{mark}</span> : null}
      <div className="bx-top__title">
        {eyebrow ? <p className="bx-eyebrow">{eyebrow}</p> : null}
        {title ? <h1 className="bx-h2">{title}</h1> : null}
      </div>
      {end}
    </header>
  );
}

/* Bottom tabs on a phone; a side rail on a wide screen when the shell is railed. */
export function TabBar({ tabs, current, onChange, brand }) {
  return (
    <nav className="bx-tabs" aria-label="Main" data-brand={brand}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="bx-tab"
          aria-current={tab.id === current ? 'page' : undefined}
          onClick={() => onChange(tab.id)}
        >
          <Icon name={tab.icon} />
          <span>{tab.label}</span>
          {tab.badge ? <span className="bx-tab__badge">{tab.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
}

export function Stats({ children, four }) {
  return <dl className={cx('bx-stats', four && 'bx-stats--4')}>{children}</dl>;
}

export function Stat({ label, value, sub, tone }) {
  return (
    <div className="bx-stat">
      <dt className="bx-stat__label">{label}</dt>
      <dd className={cx('bx-stat__value', tone === 'in' && 'bx-money--in')} style={{ margin: 0 }}>{value}</dd>
      {sub ? <dd className="bx-stat__sub" style={{ margin: 0 }}>{sub}</dd> : null}
    </div>
  );
}

/* रु with the sign always written. Money in is green, money out is ink. */
export function Money({ value, signed, className }) {
  const amount = Number(value) || 0;
  const sign = signed ? (amount > 0 ? '+ ' : amount < 0 ? '− ' : '') : amount < 0 ? '− ' : '';
  const tone = signed ? (amount > 0 ? 'bx-money--in' : 'bx-money--out') : '';
  return <span className={cx('bx-money', tone, className)}>{sign}रु {Math.abs(amount).toLocaleString('en-IN')}</span>;
}

export function List({ children }) {
  return <ul className="bx-list">{children}</ul>;
}

export function Item({ icon, tone, title, sub, end, onClick, chevron }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <li>
      <Tag className="bx-item" onClick={onClick} type={onClick ? 'button' : undefined}>
        {icon ? <span className={cx('bx-item__icon', tone && `bx-item__icon--${tone}`)}><Icon name={icon} /></span> : null}
        <span className="bx-item__body">
          <span className="bx-item__title">{title}</span>
          {sub ? <span className="bx-item__sub">{sub}</span> : null}
        </span>
        {end ? <span className="bx-item__end">{end}</span> : null}
        {chevron || onClick ? <Icon name="chevron" className="bx-item__chev" /> : null}
      </Tag>
    </li>
  );
}

/* Skeleton rows in the shape of the list they stand in for. */
export function SkeletonList({ rows = 4 }) {
  return (
    <ul className="bx-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i}>
          <div className="bx-item">
            <span className="bx-skel" style={{ width: 40, height: 40, borderRadius: 12 }} />
            <span className="bx-item__body">
              <span className="bx-skel" style={{ width: `${55 + ((i * 17) % 30)}%`, height: 14 }} />
              <span className="bx-skel" style={{ width: '35%', height: 12, marginTop: 8 }} />
            </span>
            <span className="bx-skel" style={{ width: 56, height: 16 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Empty({ icon = 'inbox', title, children, action, error }) {
  return (
    <div className={cx('bx-empty', error && 'bx-empty--error')} role={error ? 'alert' : undefined}>
      <span className="bx-empty__icon"><Icon name={error ? 'alert' : icon} /></span>
      <h3 className="bx-h3">{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Note({ tone, icon, children }) {
  return (
    <div className={cx('bx-note', tone && `bx-note--${tone}`)} role={tone === 'bad' ? 'alert' : undefined}>
      <Icon name={icon ?? (tone === 'ok' ? 'check' : tone ? 'alert' : 'info')} />
      <div>{children}</div>
    </div>
  );
}

export function Section({ eyebrow, title, action, children }) {
  return (
    <section className="bx-section">
      {title || eyebrow || action ? (
        <div className="bx-section__head">
          <div>
            {eyebrow ? <p className="bx-eyebrow">{eyebrow}</p> : null}
            {title ? <h2 className="bx-h3" style={{ marginTop: eyebrow ? 4 : 0 }}>{title}</h2> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Sheet({ open, onClose, label, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    const previous = document.activeElement;
    ref.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="bx-scrim" onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="bx-sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        <div className="bx-sheet__grip" />
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="bx-field">
      <span className="bx-field__label">{label}</span>
      {children}
      {error ? <span className="bx-field__error">{error}</span> : hint ? <span className="bx-field__hint">{hint}</span> : null}
    </label>
  );
}

/* A Nepali number plate from a vehicle id: BA2KHA4412 -> बा २ ख ४४१२. */
export function Plate({ plate, line, size = 18 }) {
  if (!plate) return null;
  return (
    <span className={cx('bx-plate', line && 'bx-plate--line')} style={{ fontSize: size }} aria-label={`Bus ${plate.province} ${plate.number} ${plate.series} ${plate.digits}`}>
      <span className="bx-plate__top">{plate.province} {plate.number} {plate.series}</span>
      <span className="bx-plate__digits">{plate.digits}</span>
    </span>
  );
}

export function Stamp({ children, tone, small }) {
  return <span className={cx('bx-stamp', tone === 'in' && 'bx-stamp--in', small && 'bx-stamp--sm')}>{children}</span>;
}

/*
  A state in words, with a shape beside it so it never rests on colour alone:
  a solid dot is happening now, a ring is waiting, a cross is refused.
  tone: live | ok | wait | bad | off
*/
export function Status({ tone = 'off', children }) {
  return (
    <span className={cx('bx-status', `bx-status--${tone}`)}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

/*
  Marks anything a judge could take for real data when it is not: the demo
  fleet, sample audit rows, a simulated odometer. Small on purpose — honest,
  not a warning banner.
*/
export function DemoTag({ children = 'Demo', title }) {
  return <span className="bx-demo" title={title}>{children}</span>;
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="bx-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
