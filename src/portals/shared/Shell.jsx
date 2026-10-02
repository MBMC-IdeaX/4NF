// The frame every office portal shares: a dark bar with the mark and who is
// signed in, an optional row of tabs, and a centred page.

import { navigate } from '../../lib/router';
import Icon from './Icon';
import './portal.css';
import './portal-v2.css';
// Loaded last on purpose: it takes over the `op-` classes and turns the office
// surfaces from a printed document into an app. See the note at its head.
import './portal-app.css';

export default function Shell({ label, who, onSignOut, tabs, tab, onTab, bare = false, children }) {
  return (
    <div className="op">
      <header className="op-top">
        <div className="op-wrap">
          <button type="button" className="op-brand" onClick={() => navigate('/')}>
            भाडा<span>{label}</span>
          </button>
          {onSignOut ? (
            <div className="op-who">
              {who ? (
                <div className="op-who__name">
                  <b>{who.name}</b>
                  {who.sub ? <small>{who.sub}</small> : null}
                </div>
              ) : null}
              <button type="button" className="op-signout" onClick={onSignOut}>Sign out</button>
            </div>
          ) : null}
        </div>
      </header>

      {tabs ? (
        <nav className="op-nav" aria-label={label}>
          <div className="op-wrap">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className="op-tab"
                aria-current={tab === t.id ? 'page' : undefined}
                onClick={() => onTab(t.id)}
              >
                <b>{t.ne}</b>
                <small>{t.en}</small>
                {t.badge ? <span className="op-badge">{t.badge}</span> : null}
              </button>
            ))}
          </div>
        </nav>
      ) : null}

      <main className={`op-wrap${bare ? '' : ' op-main'}`}>{children}</main>
    </div>
  );
}

export function PageError({ title, detail, onRetry }) {
  return (
    <div className="op-empty op-empty--page">
      <i><Icon name="alert" size={24} /></i>
      <b>{title}</b>
      {detail ? <p>{detail}</p> : null}
      {onRetry ? <button type="button" className="op-btn" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}
