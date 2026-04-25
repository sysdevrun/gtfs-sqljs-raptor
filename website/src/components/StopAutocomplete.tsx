import { useEffect, useId, useRef, useState } from 'react';
import type { Remote } from 'comlink';
import type { WorkerApi, NamedStopGroup } from '../worker/api';

interface Props {
  label: string;
  value: NamedStopGroup | null;
  onChange: (group: NamedStopGroup | null) => void;
  worker: Remote<WorkerApi>;
  placeholder?: string;
  disabled?: boolean;
}

export function StopAutocomplete({ label, value, onChange, worker, placeholder, disabled }: Props) {
  const id = useId();
  const [text, setText] = useState(value?.name ?? '');
  const [results, setResults] = useState<NamedStopGroup[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    setText(value?.name ?? '');
  }, [value]);

  useEffect(() => {
    if (text.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const myRequest = ++requestRef.current;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const r = await worker.searchStopGroups(text, 15);
        if (myRequest !== requestRef.current) return;
        setResults(r);
        setActiveIndex(0);
      } finally {
        if (myRequest === requestRef.current) setSearching(false);
      }
    }, 150);
    return () => clearTimeout(handle);
  }, [text, worker]);

  const choose = (g: NamedStopGroup) => {
    onChange(g);
    setText(g.name);
    setOpen(false);
  };

  return (
    <div className="autocomplete">
      <label htmlFor={id} className="autocomplete__label">
        {label}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        className="autocomplete__input"
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (value && e.target.value !== value.name) onChange(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open || results.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(results[activeIndex]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && (results.length > 0 || searching || (text.trim().length >= 2 && !searching)) && (
        <ul className="autocomplete__menu" role="listbox">
          {searching && <li className="autocomplete__item autocomplete__item--hint">Searching…</li>}
          {!searching && results.length === 0 && text.trim().length >= 2 && (
            <li className="autocomplete__item autocomplete__item--hint">No matches</li>
          )}
          {results.map((g, i) => (
            <li
              key={`${g.name}::${g.stopIds.join(',')}`}
              className={`autocomplete__item${i === activeIndex ? ' autocomplete__item--active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(g);
              }}
              onMouseEnter={() => setActiveIndex(i)}
              role="option"
              aria-selected={i === activeIndex}
            >
              <span className="autocomplete__name">{g.name}</span>
              <span className="autocomplete__meta">
                {g.stopIds.length} platform{g.stopIds.length > 1 ? 's' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
