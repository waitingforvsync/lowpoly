import { activeTool, gridStep, rotationStep, selectionMode, snapEnabled } from '../editor/state';
import { toolById } from '../editor/tools';
import { Empty, Panel } from './Panel';

/** Context-sensitive properties: the selection (M2+), then options for the active tool. */
export function Properties() {
  const tool = toolById(activeTool.value);
  return (
    <Panel title="Properties">
      <h3 class="subhead">Selection</h3>
      <Empty>Nothing selected ({selectionMode.value} mode)</Empty>

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
    </Panel>
  );
}

function NumberField({
  value,
  min,
  onCommit,
}: {
  value: number;
  min: number;
  onCommit: (v: number) => void;
}) {
  return (
    <input
      type="number"
      class="num"
      value={value}
      min={min}
      step="any"
      onChange={(e) => {
        const v = Number(e.currentTarget.value);
        if (Number.isFinite(v) && v >= min) onCommit(v);
        else e.currentTarget.value = String(value);
      }}
    />
  );
}
