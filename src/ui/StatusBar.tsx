import { applyMeasure, currentMeasure, measureTyped } from '../editor/measure';
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
      <MeasureBox />
    </footer>
  );
}

/**
 * The measurement box: shows the value of the operation in progress. When a tool accepts a typed
 * value (its label shows), typing anywhere fills the box; Enter applies it. It can also be clicked
 * and typed into directly.
 */
function MeasureBox() {
  const handler = currentMeasure();
  const typed = measureTyped.value;
  return (
    <label
      class={`measure${handler ? ' accepts' : ''}${typed !== null ? ' typing' : ''}`}
      title={handler ? `Type a value and press Enter to set the ${handler.label.toLowerCase()} exactly` : 'The value of the operation in progress'}
    >
      <span>{handler?.label ?? 'Measure'}</span>
      <input
        type="text"
        readOnly={!handler}
        value={typed ?? measurement.value ?? ''}
        placeholder="—"
        onInput={(e) => (measureTyped.value = e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            applyMeasure(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            measureTyped.value = null;
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
