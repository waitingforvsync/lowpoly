export type ToolId =
  | 'select'
  | 'move'
  | 'rotate'
  | 'scale'
  | 'pushpull'
  | 'extrude'
  | 'inset'
  | 'loopcut'
  | 'line'
  | 'rectangle'
  | 'paint';

export interface ToolDef {
  id: ToolId;
  label: string;
  /** KeyboardEvent.code that activates the tool. */
  code: string;
  /** Human-readable shortcut. */
  key: string;
  /** Status-bar hint shown while the tool is active. */
  hint: string;
}

export const TOOLS: readonly ToolDef[] = [
  { id: 'select', label: 'Select', code: 'Space', key: 'Space', hint: 'Click to select. Shift adds, Ctrl toggles. Esc clears.' },
  { id: 'move', label: 'Move', code: 'KeyM', key: 'M', hint: 'Drag the gizmo to move the selection. Type a distance to set it exactly.' },
  { id: 'rotate', label: 'Rotate', code: 'KeyQ', key: 'Q', hint: 'Drag the gizmo to rotate the selection. Type an angle to set it exactly.' },
  { id: 'scale', label: 'Scale', code: 'KeyS', key: 'S', hint: 'Drag the gizmo to scale the selection. Type a factor to set it exactly.' },
  { id: 'pushpull', label: 'Push/Pull', code: 'KeyP', key: 'P', hint: 'Drag a face to extrude it along its normal.' },
  { id: 'extrude', label: 'Extrude', code: 'KeyE', key: 'E', hint: 'Drag to extrude the selected vertices, edges or faces.' },
  { id: 'inset', label: 'Inset', code: 'KeyI', key: 'I', hint: 'Drag to inset the selected faces.' },
  { id: 'loopcut', label: 'Loop Cut', code: 'KeyK', key: 'K', hint: 'Hover an edge to preview a loop cut, then click to cut.' },
  { id: 'line', label: 'Line', code: 'KeyL', key: 'L', hint: 'Click to place points. Closing a loop makes a face.' },
  { id: 'rectangle', label: 'Rectangle', code: 'KeyR', key: 'R', hint: 'Click two corners to draw a rectangle on the ground or a face.' },
  { id: 'paint', label: 'Paint', code: 'KeyB', key: 'B', hint: 'Click faces to apply the active material. Alt+click samples a material.' },
];

export function toolById(id: ToolId): ToolDef {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool;
}
