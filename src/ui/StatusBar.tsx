import { activeTool, cursorWorld } from '../editor/state';
import { toolById } from '../editor/tools';

function fmt(n: number): string {
  return n.toFixed(2);
}

export function StatusBar() {
  const cursor = cursorWorld.value;
  return (
    <footer class="statusbar">
      <span class="status-hint">{toolById(activeTool.value).hint}</span>
      <span class="status-coords" title="Cursor position on the ground plane">
        {cursor ? `X ${fmt(cursor[0])}  Y ${fmt(cursor[1])}  Z ${fmt(cursor[2])}` : ''}
      </span>
      <label class="measure" title="Measurement box: type a value during an operation (M6)">
        <span>Measure</span>
        <input type="text" disabled placeholder="—" />
      </label>
    </footer>
  );
}
