// The last screen standing when a render throws.
//
// Without it React unmounts everything and a conductor holding the phone sees
// white. This says what happened in both languages, reports it, and offers the
// one thing that fixes most of these: a reload. Nothing the app has stored is
// touched — keys, rides and receipts live in IndexedDB and survive a reload.

import { Component } from 'react';
import { reportError } from '../lib/report';

export default class Crashed extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (info?.componentStack && error && typeof error === 'object') {
      error.stack = `${error.stack ?? ''}\n--- component stack ---${info.componentStack}`;
    }
    reportError(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crashed" role="alert">
        <h1>केही बिग्रियो</h1>
        <p>Something on this screen broke. Your rides, receipts and balance are saved on this phone and are not affected.</p>
        <button type="button" className="crashed__reload" onClick={() => window.location.reload()}>
          फेरि खोल्नुहोस् · Reload
        </button>
        <p className="crashed__detail">{String(this.state.error?.message ?? this.state.error)}</p>
      </div>
    );
  }
}
