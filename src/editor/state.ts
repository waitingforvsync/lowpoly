import { signal } from '@preact/signals';
import type { ToolId } from './tools';

/** Editor-wide UI state. Not part of the document, and never recorded in undo history. */

export type SelectionMode = 'object' | 'vertex' | 'edge' | 'face';
export type Projection = 'perspective' | 'orthographic';
export type Vec3Tuple = [number, number, number];

export const selectionMode = signal<SelectionMode>('object');
export const activeTool = signal<ToolId>('select');

export const snapEnabled = signal(true);
export const gridStep = signal(0.25);
export const GRID_STEPS = [0.1, 0.25, 0.5, 1] as const;
export const rotationStep = signal(15);

export const projection = signal<Projection>('perspective');

/** Snapped world-space position of the pointer on the ground plane, or null when off-canvas. */
export const cursorWorld = signal<Vec3Tuple | null>(null);
