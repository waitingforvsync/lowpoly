import { signal } from '@preact/signals';
import type { ToolId } from './tools';

/** Editor-wide UI state. Not part of the document, and never recorded in undo history. */

export type SelectionMode = 'object' | 'vertex' | 'edge' | 'face';
export type Projection = 'perspective' | 'orthographic';
export type Vec3Tuple = [number, number, number];

export const selectionMode = signal<SelectionMode>('object');
export const activeTool = signal<ToolId>('select');

export const snapEnabled = signal(true);
/** True while Ctrl is held, which temporarily inverts grid snapping. */
export const snapInvertHeld = signal(false);
export const gridStep = signal(0.25);
export const GRID_STEPS = [0.1, 0.25, 0.5, 1] as const;
export const rotationStep = signal(15);

export const projection = signal<Projection>('perspective');
export const transformSpace = signal<'world' | 'local'>('world');

/** See-through display: faces become translucent and occluded elements can be picked. */
export const xray = signal(false);

/** A transient message for the status bar, e.g. why an operation was refused. */
export const statusMessage = signal<{ text: string; kind: 'info' | 'error' } | null>(null);
let messageTimer: ReturnType<typeof setTimeout> | undefined;

export function showStatus(text: string, kind: 'info' | 'error' = 'info'): void {
  statusMessage.value = { text, kind };
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (statusMessage.value = null), 4000);
}

/** Snapped world-space position of the pointer on the ground plane, or null when off-canvas. */
export const cursorWorld = signal<Vec3Tuple | null>(null);

/**
 * Texture lock: walls created by extrude and push/pull continue the texture of the face across
 * their base edge. Off: they get a fresh world-space planar projection.
 */
export const textureLock = signal(true);

/** Inset as a ring of quads, or as a hole filled by the inset face (SketchUp's Offset). */
export const insetMode = signal<'ring' | 'hole'>('ring');

/** The value of the operation in progress (e.g. a push/pull distance), shown in the status bar. */
export const measurement = signal<string | null>(null);

/** The material the Paint tool applies (chosen in the outliner, or sampled with Alt+click). */
export const activeMaterial = signal(0);

/** Show image textures in the viewport (off: plain material colours). */
export const showTextures = signal(true);

/** The UV editor panel is open. */
export const uvPanelOpen = signal(false);
