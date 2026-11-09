import type { ComponentChildren } from 'preact';
import {
  activeTool,
  GRID_STEPS,
  gridStep,
  projection,
  selectionMode,
  snapEnabled,
  type SelectionMode,
} from '../editor/state';
import { TOOLS } from '../editor/tools';
import { setStandardView, toggleProjection } from '../editor/viewActions';
import type { StandardView } from '../render/Viewport';

const MODES: { id: SelectionMode; label: string; key: string }[] = [
  { id: 'object', label: 'Object', key: '1' },
  { id: 'vertex', label: 'Vertex', key: '2' },
  { id: 'edge', label: 'Edge', key: '3' },
  { id: 'face', label: 'Face', key: '4' },
];

const VIEWS: { id: StandardView; label: string; key: string }[] = [
  { id: 'top', label: 'Top', key: 'Numpad 7' },
  { id: 'front', label: 'Front', key: 'Numpad 1' },
  { id: 'right', label: 'Right', key: 'Numpad 3' },
  { id: 'iso', label: 'Iso', key: 'Numpad 0' },
];

export function Toolbar() {
  return (
    <header class="toolbar">
      <Group label="History">
        <Button title="Undo (Ctrl+Z)" disabled>Undo</Button>
        <Button title="Redo (Ctrl+Y)" disabled>Redo</Button>
      </Group>

      <Group label="Selection mode">
        {MODES.map((m) => (
          <Button
            key={m.id}
            title={`${m.label} mode (${m.key})`}
            active={selectionMode.value === m.id}
            onClick={() => (selectionMode.value = m.id)}
          >
            {m.label}
          </Button>
        ))}
      </Group>

      <Group label="Tools">
        {TOOLS.map((t) => (
          <Button
            key={t.id}
            title={`${t.label} (${t.key})`}
            active={activeTool.value === t.id}
            onClick={() => (activeTool.value = t.id)}
          >
            {t.label}
          </Button>
        ))}
      </Group>

      <Group label="Snapping">
        <Button
          title="Toggle grid snap (G). Hold Ctrl to invert temporarily."
          active={snapEnabled.value}
          onClick={() => (snapEnabled.value = !snapEnabled.value)}
        >
          Snap
        </Button>
        <select
          class="tb-select"
          title="Grid step"
          value={String(gridStep.value)}
          onChange={(e) => (gridStep.value = Number(e.currentTarget.value))}
        >
          {GRID_STEPS.map((s) => (
            <option key={s} value={String(s)}>
              {s}
            </option>
          ))}
        </select>
      </Group>

      <div class="toolbar-spacer" />

      <Group label="View">
        {VIEWS.map((v) => (
          <Button key={v.id} title={`${v.label} view (${v.key})`} onClick={() => setStandardView(v.id)}>
            {v.label}
          </Button>
        ))}
        <Button title="Toggle perspective / orthographic (Numpad 5)" onClick={toggleProjection}>
          {projection.value === 'perspective' ? 'Persp' : 'Ortho'}
        </Button>
      </Group>
    </header>
  );
}

function Group({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="tb-group" role="group" aria-label={label}>
      {children}
    </div>
  );
}

interface ButtonProps {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ComponentChildren;
}

function Button({ title, active, disabled, onClick, children }: ButtonProps) {
  return (
    <button
      type="button"
      class={active ? 'tb-button active' : 'tb-button'}
      title={title}
      aria-pressed={active}
      disabled={disabled}
      // Don't take keyboard focus on click: Space is a tool shortcut and would re-press the button.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
