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
  { id: 'select', label: 'Select', code: 'Space', key: 'Space', hint: 'Click to select; drag left→right for a window, right→left for a crossing box. Shift adds, Ctrl toggles. Esc clears.' },
  { id: 'move', label: 'Move', code: 'KeyM', key: 'M', hint: 'Drag the gizmo to move the selection. Type a distance to set it exactly.' },
  { id: 'rotate', label: 'Rotate', code: 'KeyQ', key: 'Q', hint: 'Drag the gizmo to rotate the selection. Type an angle to set it exactly.' },
  { id: 'scale', label: 'Scale', code: 'KeyS', key: 'S', hint: 'Drag the gizmo to scale the selection. Type a factor to set it exactly.' },
  { id: 'pushpull', label: 'Push/Pull', code: 'KeyP', key: 'P', hint: 'Drag a face along its normal (all selected faces, if it is one of them). Esc cancels.' },
  { id: 'extrude', label: 'Extrude', code: 'KeyE', key: 'E', hint: 'Drag the gizmo to extrude the selected vertices, edges or faces.' },
  { id: 'inset', label: 'Inset', code: 'KeyI', key: 'I', hint: 'Drag across a face to inset it (all selected faces, if it is one of them). Esc cancels.' },
  { id: 'loopcut', label: 'Loop Cut', code: 'KeyK', key: 'K', hint: 'Hover an edge to preview a cut across its ring of quads; click to cut. Then type a number for that many even cuts.' },
  { id: 'line', label: 'Line', code: 'KeyL', key: 'L', hint: 'Click to place points. Edge to edge splits a face; a closed loop makes a face. Arrows lock X/Y/Z (↓ the inferred edge), Shift holds a lock. Type a length.' },
  { id: 'rectangle', label: 'Rectangle', code: 'KeyR', key: 'R', hint: 'Click two corners to draw a rectangle on a face or on the ground. Type width,height to set its size.' },
  { id: 'paint', label: 'Paint', code: 'KeyB', key: 'B', hint: 'Click a face to paint it (a selected face paints the selection). Ctrl: connected faces of that material; Shift: all of its faces on the object. Alt+click samples.' },
];

export function toolById(id: ToolId): ToolDef {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool;
}
