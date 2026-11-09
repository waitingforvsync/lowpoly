import { useRef, useState } from 'preact/hooks';
import type { Material, SceneObject } from '../core/document';
import { DEFAULT_MATERIAL_ID, DEFAULT_TEXTURE_SIZE } from '../core/document';
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
import { clearMaterialTexture, loadMaterialTexture, paintMaterial, setMaterialTextureSize } from '../editor/materialActions';
import { activeMaterial } from '../editor/state';
import { hexToRgb, NumberField, rgbToHex, TextField } from './fields';
import { EyeIcon, EyeOffIcon, LockIcon, UnlockIcon } from './icons';
import { useDoc } from './useDoc';
import { Empty, Panel } from './Panel';

export function Outliner() {
  void editor.docVersion.value; // re-render on any document change
  void activeMaterial.value;
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
          <MaterialRow key={m.id} mat={m} active={m.id === paintMaterial()} />
        ))}
      </ul>
      <MaterialDetails />
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

function MaterialRow({ mat, active }: { mat: Material; active: boolean }) {
  const doc = useDoc();
  const [editing, setEditing] = useState(false);
  const before = useRef<Vec3 | null>(null);
  const tex = doc.materialTexture(mat);

  return (
    <li
      class={active ? 'tree-row selected' : 'tree-row'}
      title="Click to paint with this material (Paint tool, B)"
      onClick={() => (activeMaterial.value = mat.id)}
      onDblClick={() => setEditing(true)}
    >
      {tex && <img class="swatch-img" src={tex.data} alt="" title={tex.name} />}
      <input
        type="color"
        class="swatch"
        title={tex ? 'Colour (shown when textures are off)' : 'Colour'}
        value={rgbToHex(mat.color)}
        onClick={(e) => e.stopPropagation()}
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
          onClick={(e) => {
            e.stopPropagation();
            deleteMaterial(mat.id);
          }}
        >
          ×
        </button>
      )}
    </li>
  );
}

/** Texture settings of the active material. */
function MaterialDetails() {
  const doc = useDoc();
  void activeMaterial.value; // paintMaterial() only peeks; subscribe here
  const mat = doc.findMaterial(paintMaterial());
  if (!mat) return null;
  const tex = doc.materialTexture(mat);
  const size = mat.textureSize ?? DEFAULT_TEXTURE_SIZE;
  return (
    <>
      <h3 class="subhead">Material: {mat.name}</h3>
      <dl class="props">
        <dt>Texture</dt>
        <dd class="op-row">
          {tex ? (
            <span class="tex-name" title={`${tex.name} (${tex.width}×${tex.height})`}>
              {tex.name}
            </span>
          ) : (
            <span class="dim">None</span>
          )}
          <button type="button" class="tb-button" title="Load an image (PNG, JPEG, WebP)" onClick={() => void loadMaterialTexture(mat.id)}>
            Load…
          </button>
          {tex && (
            <button type="button" class="tb-button" title="Remove the texture" onClick={() => clearMaterialTexture(mat.id)}>
              Clear
            </button>
          )}
        </dd>
        {tex && (
          <>
            <dt title="World size of one repeat of the image">Tile size</dt>
            <dd class="op-row">
              <NumberField value={size[0]} min={0.001} title="Width (world units)" onCommit={(w) => setMaterialTextureSize(mat.id, [w, size[1]])} />
              <NumberField value={size[1]} min={0.001} title="Height (world units)" onCommit={(h) => setMaterialTextureSize(mat.id, [size[0], h])} />
            </dd>
          </>
        )}
      </dl>
    </>
  );
}
