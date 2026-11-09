import type { ComponentChildren } from 'preact';
import {
  activeTool,
  GRID_STEPS,
  gridStep,
  projection,
  selectionMode,
  showTextures,
  snapEnabled,
  textureLock,
  transformSpace,
  xray,
  type SelectionMode,
} from '../editor/state';
import { setSelectionMode } from '../editor/modes';
import { TOOLS } from '../editor/tools';
import { setStandardView, spawnPoint, toggleProjection } from '../editor/viewActions';
import { createPrimitive } from '../editor/actions';
import { editor } from '../editor/editor';
import { PRIMITIVE_TYPES, PRIMITIVES, type PrimitiveType } from '../core/primitives';
import { newDocument, openDocument, saveDocument } from '../io/file';
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
  void editor.historyVersion.value; // re-render when undo/redo availability changes
  const undoLabel = editor.history.undoLabel;
  const redoLabel = editor.history.redoLabel;

  return (
    <header class="toolbar">
      <Group label="File">
        <Button title="New document" onClick={newDocument}>
          New
        </Button>
        <Button title="Open… (Ctrl+O)" onClick={() => void openDocument()}>
          Open
        </Button>
        <Button title="Save (Ctrl+S). Save As: Ctrl+Shift+S" onClick={() => void saveDocument()}>
          Save
        </Button>
      </Group>

      <Group label="History">
        <Button title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'} disabled={!undoLabel} onClick={() => editor.undo()}>
          Undo
        </Button>
        <Button title={redoLabel ? `Redo ${redoLabel} (Ctrl+Y)` : 'Nothing to redo'} disabled={!redoLabel} onClick={() => editor.redo()}>
          Redo
        </Button>
      </Group>

      <Group label="Create">
        <select
          class="tb-select"
          title="Create a primitive"
          value=""
          onChange={(e) => {
            const type = e.currentTarget.value as PrimitiveType;
            e.currentTarget.value = '';
            if (type) createPrimitive(type, spawnPoint());
          }}
        >
          <option value="" disabled hidden>
            Add…
          </option>
          {PRIMITIVE_TYPES.map((t) => (
            <option key={t} value={t}>
              {PRIMITIVES[t].label}
            </option>
          ))}
        </select>
      </Group>

      <Group label="Selection mode">
        {MODES.map((m) => (
          <Button
            key={m.id}
            title={`${m.label} mode (${m.key})`}
            active={selectionMode.value === m.id}
            onClick={() => setSelectionMode(m.id)}
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
        <Button
          title="Gizmo orientation for a single object: world axes or the object's own axes"
          onClick={() => (transformSpace.value = transformSpace.value === 'world' ? 'local' : 'world')}
        >
          {transformSpace.value === 'world' ? 'World' : 'Local'}
        </Button>
        <Button
          title="X-ray (X): see through faces and select hidden elements"
          active={xray.value}
          onClick={() => (xray.value = !xray.value)}
        >
          X-ray
        </Button>
        <Button
          title="Texture lock: walls made by extrude and push/pull continue the texture of the face beside them"
          active={textureLock.value}
          onClick={() => (textureLock.value = !textureLock.value)}
        >
          Tex Lock
        </Button>
        <Button title="Show image textures (off: plain material colours)" active={showTextures.value} onClick={() => (showTextures.value = !showTextures.value)}>
          Textures
        </Button>
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
