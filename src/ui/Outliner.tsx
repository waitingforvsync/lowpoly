import { useRef, useState } from 'preact/hooks';
import type { Material, SceneObject } from '../core/document';
import { DEFAULT_MATERIAL_ID } from '../core/document';
import type { Vec3 } from '../core/math/vec';
import {
  addMaterial,
  commitMaterialColor,
  deleteMaterial,
  previewMaterialColor,
  renameMaterial,
  renameObject,
  setObjectsLocked,
  setObjectsVisible,
} from '../editor/actions';
import { editor } from '../editor/editor';
import { addToSelection, selectedObjects, selectOnly, toggleSelection } from '../editor/selection';
import { hexToRgb, rgbToHex, TextField } from './fields';
import { EyeIcon, EyeOffIcon, LockIcon, UnlockIcon } from './icons';
import { useDoc } from './useDoc';
import { Empty, Panel } from './Panel';

export function Outliner() {
  void editor.docVersion.value; // re-render on any document change
  const doc = editor.doc;
  return (
    <Panel title="Outliner">
      <h3 class="subhead">Objects</h3>
      {doc.objects.length === 0 ? (
        <Empty>No objects. Use Add… to create one.</Empty>
      ) : (
        <ul class="tree">
          {doc.objects.map((o) => (
            <ObjectRow key={o.id} obj={o} selected={selectedObjects.value.has(o.id)} />
          ))}
        </ul>
      )}

      <h3 class="subhead subhead-row">
        Materials
        <button type="button" class="icon-button" title="Add material" onClick={() => addMaterial()}>
          +
        </button>
      </h3>
      <ul class="tree">
        {doc.materials.map((m) => (
          <MaterialRow key={m.id} mat={m} />
        ))}
      </ul>
    </Panel>
  );
}

function ObjectRow({ obj, selected }: { obj: SceneObject; selected: boolean }) {
  useDoc();
  const [editing, setEditing] = useState(false);
  const cls = ['tree-row', selected && 'selected', !obj.visible && 'hidden', obj.locked && 'locked']
    .filter(Boolean)
    .join(' ');

  const onClick = (e: MouseEvent) => {
    if (!obj.visible) return; // hidden objects can't be selected
    if (e.ctrlKey || e.metaKey) toggleSelection(obj.id);
    else if (e.shiftKey) addToSelection(obj.id);
    else selectOnly(obj.id);
  };

  return (
    <li class={cls} onClick={onClick} onDblClick={() => setEditing(true)}>
      <button
        type="button"
        class="icon-button"
        title={obj.visible ? 'Hide' : 'Show'}
        aria-pressed={obj.visible}
        onClick={(e) => {
          e.stopPropagation();
          setObjectsVisible([obj.id], !obj.visible);
        }}
      >
        {obj.visible ? <EyeIcon /> : <EyeOffIcon />}
      </button>
      {editing ? (
        <TextField
          class="field tree-edit"
          value={obj.name}
          autoFocus
          onBlur={() => setEditing(false)}
          onClick={(e) => e.stopPropagation()}
          onCommit={(name) => {
            renameObject(obj.id, name);
            setEditing(false);
          }}
        />
      ) : (
        <span class="tree-name" title="Double-click to rename">
          {obj.name}
        </span>
      )}
      <button
        type="button"
        class="icon-button"
        title={obj.locked ? 'Unlock' : 'Lock (prevents selecting and editing in the viewport)'}
        aria-pressed={obj.locked}
        onClick={(e) => {
          e.stopPropagation();
          setObjectsLocked([obj.id], !obj.locked);
        }}
      >
        {obj.locked ? <LockIcon /> : <UnlockIcon />}
      </button>
    </li>
  );
}

function MaterialRow({ mat }: { mat: Material }) {
  useDoc();
  const [editing, setEditing] = useState(false);
  const before = useRef<Vec3 | null>(null);

  return (
    <li class="tree-row" onDblClick={() => setEditing(true)}>
      <input
        type="color"
        class="swatch"
        title="Colour"
        value={rgbToHex(mat.color)}
        onInput={(e) => {
          before.current ??= [...mat.color];
          previewMaterialColor(mat.id, hexToRgb(e.currentTarget.value));
        }}
        onChange={(e) => {
          commitMaterialColor(mat.id, hexToRgb(e.currentTarget.value), before.current ?? [...mat.color]);
          before.current = null;
        }}
      />
      {editing ? (
        <TextField
          class="field tree-edit"
          value={mat.name}
          autoFocus
          onBlur={() => setEditing(false)}
          onCommit={(name) => {
            renameMaterial(mat.id, name);
            setEditing(false);
          }}
        />
      ) : (
        <span class="tree-name" title="Double-click to rename">
          {mat.name}
        </span>
      )}
      {mat.id !== DEFAULT_MATERIAL_ID && (
        <button
          type="button"
          class="icon-button"
          title="Delete material (faces revert to Default)"
          onClick={() => deleteMaterial(mat.id)}
        >
          ×
        </button>
      )}
    </li>
  );
}
