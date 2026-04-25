import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import 'react-gtfs-selector/style.css';

// Note: NOT wrapped in <React.StrictMode>. StrictMode double-invokes useEffect
// in dev, which creates the Web Worker twice — the terminated first worker
// fires an opaque "undefined undefined undefined" ErrorEvent on the listener
// we attach to the second one, looking like a startup failure that didn't
// actually happen. If you re-enable StrictMode, the worker effect needs to be
// idempotent (e.g. cache the worker on module scope rather than React state).
createRoot(document.getElementById('root')!).render(<App />);
