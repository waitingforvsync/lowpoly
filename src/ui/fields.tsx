import type { TargetedKeyboardEvent } from 'preact';
import type { Vec3 } from '../core/math/vec';

/** Format a number for display: up to 4 decimals, no trailing zeros, no "-0". */
export function fmt(n: number): string {
  return String(Number(n.toFixed(4)) + 0);
}

/** Enter commits (via blur), Escape restores the shown value and blurs. */
function commitKeys(original: () => string) {
  return (e: TargetedKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
    else if (e.key === 'Escape') {
      e.currentTarget.value = original();
      e.currentTarget.blur();
    }
  };
}

export function TextField({
  value,
  onCommit,
  class: cls = 'field',
  autoFocus,
  title,
  onBlur,
  onClick,
}: {
  value: string;
  onCommit: (v: string) => void;
  class?: string;
  autoFocus?: boolean;
  title?: string;
  onBlur?: () => void;
  onClick?: (e: MouseEvent) => void;
}) {
  return (
    <input
      type="text"
      class={cls}
      title={title}
      autoFocus={autoFocus}
      onBlur={onBlur}
      onClick={onClick}
      value={value}
      onKeyDown={commitKeys(() => value)}
      onChange={(e) => onCommit(e.currentTarget.value)}
    />
  );
}

export function NumberField({
  value,
  onCommit,
  min,
  max,
  integer,
  title,
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  title?: string;
}) {
  const shown = fmt(value);
  return (
    <input
      type="text"
      inputMode="decimal"
      class="field num"
      title={title}
      value={shown}
      onKeyDown={commitKeys(() => shown)}
      onChange={(e) => {
        let v = Number(e.currentTarget.value.trim());
        if (!Number.isFinite(v) || e.currentTarget.value.trim() === '') {
          e.currentTarget.value = shown;
          return;
        }
        if (integer) v = Math.round(v);
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        e.currentTarget.value = fmt(v);
        if (v !== value) onCommit(v);
      }}
    />
  );
}

const AXES = ['X', 'Y', 'Z'] as const;

export function Vec3Field({ value, onCommit, min }: { value: Vec3; onCommit: (v: Vec3) => void; min?: number }) {
  return (
    <div class="vec3">
      {AXES.map((axis, i) => (
        <label key={axis} class={`vec3-cell axis-${axis.toLowerCase()}`}>
          <span>{axis}</span>
          <NumberField
            value={value[i]!}
            min={min}
            onCommit={(v) => {
              const next: Vec3 = [...value];
              next[i] = v;
              onCommit(next);
            }}
          />
        </label>
      ))}
    </div>
  );
}

export function hexToRgb(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: Vec3): string {
  return '#' + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
}
