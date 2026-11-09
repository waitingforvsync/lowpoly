import { Fragment } from 'preact';
import { cloneTransform, type SceneObject } from '../core/document';
import { PRIMITIVES, type PrimitiveSource } from '../core/primitives';
import {
  assignMaterial,
  objectMaterial,
  renameObject,
  selectedIds,
  setObjectsLocked,
  setObjectsVisible,
  setObjectTransform,
  setPrimitiveSource,
} from '../editor/actions';
import { editor } from '../editor/editor';
import {
  componentCount,
  componentSelection,
  editObjects,
  selectedObjects,
  type ComponentMode,
} from '../editor/selection';
import { activeTool, gridStep, rotationStep, selectionMode, snapEnabled } from '../editor/state';
import {
  assignMaterialToFaces,
  componentCentroid,
  deleteComponents,
  dissolveComponents,
  mergeComponentsAtCenter,
  mergeComponentsByDistance,
  moveComponentsTo,
  selectedEdgesHard,
  selectedFacesMaterial,
  setEdgesHard,
} from '../editor/componentActions';
import { isComponentMode } from '../editor/modes';
import { toolById } from '../editor/tools';
import { NumberField, TextField, Vec3Field } from './fields';
import { useDoc } from './useDoc';
import { Empty, Panel } from './Panel';

/** Context-sensitive properties: the selection, then options for the active tool. */
export function Properties() {
  void editor.docVersion.value;
  void selectedObjects.value;
  const ids = selectedIds();
  const doc = editor.doc;

  const mode = selectionMode.value;
  if (isComponentMode(mode)) {
    return (
      <Panel title="Properties">
        <ComponentProps mode={mode} />
        <ToolOptions />
      </Panel>
    );
  }

  return (
    <Panel title="Properties">
      {ids.length === 0 && <Empty>Nothing selected</Empty>}
      {ids.length === 1 && <ObjectProps key={ids[0]} obj={doc.object(ids[0]!)} />}
      {ids.length > 1 && <MultiProps ids={ids} />}
      <ToolOptions />
    </Panel>
  );
}

function ObjectProps({ obj }: { obj: SceneObject }) {
  useDoc();
  const t = obj.transform;
  const setT = (part: 'position' | 'rotation' | 'scale', label: string) => (v: [number, number, number]) => {
    const next = cloneTransform(t);
    next[part] = v;
    setObjectTransform(obj.id, next, label);
  };
  const m = obj.mesh;

  return (
    <>
      <h3 class="subhead">Object</h3>
      <dl class="props">
        <dt>Name</dt>
        <dd>
          <TextField value={obj.name} onCommit={(name) => renameObject(obj.id, name)} />
        </dd>
        <dt>Position</dt>
        <dd>
          <Vec3Field value={t.position} onCommit={setT('position', 'Move Object')} />
        </dd>
        <dt>Rotation°</dt>
        <dd>
          <Vec3Field value={t.rotation} onCommit={setT('rotation', 'Rotate Object')} />
        </dd>
        <dt>Scale</dt>
        <dd>
          <Vec3Field value={t.scale} onCommit={setT('scale', 'Scale Object')} />
        </dd>
        <dt>Visible</dt>
        <dd>
          <input
            type="checkbox"
            checked={obj.visible}
            onChange={(e) => setObjectsVisible([obj.id], e.currentTarget.checked)}
          />
        </dd>
        <dt>Locked</dt>
        <dd>
          <input
            type="checkbox"
            checked={obj.locked}
            onChange={(e) => setObjectsLocked([obj.id], e.currentTarget.checked)}
          />
        </dd>
        <dt>Material</dt>
        <dd>
          <MaterialSelect ids={[obj.id]} />
        </dd>
        <dt>Geometry</dt>
        <dd class="dim">
          {m.verts.size} verts · {m.edgeCount} edges · {m.faces.size} faces
        </dd>
      </dl>
      {obj.source && <PrimitiveProps id={obj.id} source={obj.source} />}
    </>
  );
}

function PrimitiveProps({ id, source }: { id: number; source: PrimitiveSource }) {
  useDoc();
  const def = PRIMITIVES[source.type];
  const params = source.params as unknown as Record<string, number>;
  return (
    <>
      <h3 class="subhead">{def.label}</h3>
      <dl class="props">
        {def.params.map((p) => (
          <Fragment key={p.key}>
            <dt>{p.label}</dt>
            <dd>
              <NumberField
                value={params[p.key]!}
                min={p.min}
                max={p.max}
                integer={p.integer}
                onCommit={(v) =>
                  setPrimitiveSource(id, { type: source.type, params: { ...params, [p.key]: v } } as unknown as PrimitiveSource)
                }
              />
            </dd>
          </Fragment>
        ))}
      </dl>
    </>
  );
}

function MultiProps({ ids }: { ids: number[] }) {
  const doc = useDoc();
  const allVisible = ids.every((id) => doc.object(id).visible);
  const allLocked = ids.every((id) => doc.object(id).locked);
  return (
    <>
      <h3 class="subhead">{ids.length} objects</h3>
      <dl class="props">
        <dt>Visible</dt>
        <dd>
          <input type="checkbox" checked={allVisible} onChange={(e) => setObjectsVisible(ids, e.currentTarget.checked)} />
        </dd>
        <dt>Locked</dt>
        <dd>
          <input type="checkbox" checked={allLocked} onChange={(e) => setObjectsLocked(ids, e.currentTarget.checked)} />
        </dd>
        <dt>Material</dt>
        <dd>
          <MaterialSelect ids={ids} />
        </dd>
      </dl>
    </>
  );
}

const NOUN: Record<ComponentMode, [string, string]> = {
  vertex: ['vertex', 'vertices'],
  edge: ['edge', 'edges'],
  face: ['face', 'faces'],
};

function ComponentProps({ mode }: { mode: ComponentMode }) {
  void componentSelection[mode].value;
  const doc = useDoc();
  const count = componentCount(mode);
  const editing = [...editObjects.value].map((id) => doc.findObject(id)?.name).filter(Boolean);
  const centroid = componentCentroid(mode);
  const faceMat = mode === 'face' ? selectedFacesMaterial() : undefined;
  const edgeHard = mode === 'edge' ? selectedEdgesHard() : undefined;

  return (
    <>
      <h3 class="subhead">
        {count} {NOUN[mode][count === 1 ? 0 : 1]} selected
      </h3>
      <p class="dim small">Editing: {editing.length ? editing.join(', ') : 'nothing'}</p>
      {centroid && (
        <dl class="props">
          <dt>{count === 1 && mode === 'vertex' ? 'Position' : 'Centre'}</dt>
          <dd>
            <Vec3Field value={centroid} onCommit={(v) => moveComponentsTo(mode, v)} />
          </dd>
          {mode === 'edge' && (
            <>
              <dt>Shading</dt>
              <dd class="segmented">
                <button
                  type="button"
                  class={edgeHard === true ? 'tb-button active' : 'tb-button'}
                  title="Hard: a crease; normals split across the edge"
                  onClick={() => setEdgesHard(true)}
                >
                  Hard
                </button>
                <button
                  type="button"
                  class={edgeHard === false ? 'tb-button active' : 'tb-button'}
                  title="Soft: normals are smoothed across the edge"
                  onClick={() => setEdgesHard(false)}
                >
                  Soft
                </button>
                {edgeHard === null && <span class="dim">Mixed</span>}
              </dd>
            </>
          )}
          {mode === 'face' && (
            <>
              <dt>Material</dt>
              <dd>
                <select
                  class="field"
                  value={faceMat === null || faceMat === undefined ? '' : String(faceMat)}
                  onChange={(e) => assignMaterialToFaces(Number(e.currentTarget.value))}
                >
                  {(faceMat === null || faceMat === undefined) && (
                    <option value="" disabled>
                      Mixed
                    </option>
                  )}
                  {doc.materials.map((m) => (
                    <option key={m.id} value={String(m.id)}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </dd>
            </>
          )}
        </dl>
      )}
      <div class="button-row">
        <button type="button" class="tb-button" disabled={!count} title="Delete (Del)" onClick={() => deleteComponents(mode)}>
          Delete
        </button>
        <button
          type="button"
          class="tb-button"
          disabled={!count}
          title="Dissolve: remove while keeping the surface closed (Backspace)"
          onClick={() => dissolveComponents(mode)}
        >
          Dissolve
        </button>
        <button
          type="button"
          class="tb-button"
          disabled={!count}
          title="Merge selected vertices at their centre (Ctrl+M)"
          onClick={() => mergeComponentsAtCenter(mode)}
        >
          Merge
        </button>
        <button
          type="button"
          class="tb-button"
          disabled={!count}
          title="Weld coincident vertices in the selection (Ctrl+Shift+M)"
          onClick={() => mergeComponentsByDistance(mode)}
        >
          Weld
        </button>
      </div>
    </>
  );
}

function MaterialSelect({ ids }: { ids: number[] }) {
  const doc = useDoc();
  const mats = ids.map(objectMaterial);
  const common = mats.every((m) => m === mats[0]) ? mats[0] : null;
  return (
    <select
      class="field"
      value={common === null || common === undefined ? '' : String(common)}
      onChange={(e) => assignMaterial(ids, Number(e.currentTarget.value))}
    >
      {(common === null || common === undefined) && (
        <option value="" disabled>
          Mixed
        </option>
      )}
      {doc.materials.map((m) => (
        <option key={m.id} value={String(m.id)}>
          {m.name}
        </option>
      ))}
    </select>
  );
}

function ToolOptions() {
  const tool = toolById(activeTool.value);
  return (
    <>
      <h3 class="subhead">Tool: {tool.label}</h3>
      <dl class="props">
        <dt>Grid snap</dt>
        <dd>
          <input
            type="checkbox"
            checked={snapEnabled.value}
            onChange={(e) => (snapEnabled.value = e.currentTarget.checked)}
          />
        </dd>
        <dt>Grid step</dt>
        <dd>
          <NumberField value={gridStep.value} min={0.001} onCommit={(v) => (gridStep.value = v)} />
        </dd>
        <dt>Rotation step°</dt>
        <dd>
          <NumberField value={rotationStep.value} min={0.1} onCommit={(v) => (rotationStep.value = v)} />
        </dd>
      </dl>
    </>
  );
}
