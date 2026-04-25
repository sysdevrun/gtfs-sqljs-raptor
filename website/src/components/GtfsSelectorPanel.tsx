import { useMemo, useState } from 'react';
import {
  GtfsSelector,
  fileTab,
  urlTab,
  transportDataGouvFr,
  mobilityDataCsv,
  type GtfsSelectionResult,
} from 'react-gtfs-selector';

interface Props {
  onSelected: (selection: { kind: 'file'; buffer: ArrayBuffer; name: string } | { kind: 'url'; url: string; useProxy: boolean; title: string }) => void;
  disabled?: boolean;
}

export function GtfsSelectorPanel({ onSelected, disabled }: Props) {
  const [useProxy, setUseProxy] = useState(true);

  const tabs = useMemo(() => [fileTab, urlTab, transportDataGouvFr, mobilityDataCsv], []);

  // react-gtfs-selector reports a selection through this `onSelect` callback
  // for every tab: file drop → result.type === 'file', URL form submit and
  // online-source pick → result.type === 'url'.
  const handle = async (result: GtfsSelectionResult) => {
    if (result.type === 'file') {
      const buffer = await result.blob.arrayBuffer();
      onSelected({ kind: 'file', buffer, name: result.fileName });
    } else {
      onSelected({ kind: 'url', url: result.url, useProxy, title: result.title });
    }
  };

  return (
    <section className="panel panel--selector">
      <header className="panel__header">
        <h2>1. Pick a GTFS feed</h2>
        <label className="proxy-toggle" title="Wrap https URLs with the gtfs-proxy.sys-dev-run.re CORS proxy">
          <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
          <span>Use CORS proxy for URL/online feeds</span>
        </label>
      </header>
      <div className={disabled ? 'panel__body panel__body--disabled' : 'panel__body'}>
        <GtfsSelector onSelect={handle} tabs={tabs} />
      </div>
    </section>
  );
}
