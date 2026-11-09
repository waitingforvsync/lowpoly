import { activeTool, cursorWorld, measurement, statusMessage } from '../editor/state';
import { toolById } from '../editor/tools';

function fmt(n: number): string {
  return n.toFixed(2);
}

export function StatusBar() {
  const cursor = cursorWorld.value;
  return (
    <footer class="statusbar">
      {statusMessage.value ? (
        <span class={`status-hint status-${statusMessage.value.kind}`}>{statusMessage.value.text}</span>
      ) : (
        <span class="status-hint">{toolById(activeTool.value).hint}</span>
      )}
      <span class="status-coords" title="Cursor position on the ground plane">
        {cursor ? `X ${fmt(cursor[0])}  Y ${fmt(cursor[1])}  Z ${fmt(cursor[2])}` : ''}
      </span>
      <label class="measure" title="The value of the operation in progress. Typing a value comes in M6.">
        <span>Measure</span>
        <input type="text" readOnly value={measurement.value ?? ''} placeholder="—" />
      </label>
    </footer>
  );
}
