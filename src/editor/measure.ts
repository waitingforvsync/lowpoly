import { effect, signal } from '@preact/signals';
import { editor } from './editor';
import { activeTool, showStatus } from './state';

/**
 * The measurement box (SketchUp's Value Control Box). While a tool is drawing, or right after it
 * made a change, typing a value sets it exactly: digits go straight to the box, without clicking
 * it, and Enter applies. A value typed after an operation replaces that operation (undo, then run
 * again with the value), as long as it is still the last thing done.
 */

export interface MeasureHandler {
  /** What the value means, shown beside the box: 'Length', 'Distance', 'Cuts'... */
  label: string;
  /** Apply the typed text. Returns an error message to show, if it couldn't. */
  apply(text: string): string | void;
  /** Whether the handler still applies (e.g. its operation is still the last command). */
  valid?(): boolean;
}

export const measureHandler = signal<MeasureHandler | null>(null);
/** The text being typed, or null when not typing. */
export const measureTyped = signal<string | null>(null);

export function offerMeasure(h: MeasureHandler | null): void {
  measureHandler.value = h;
  measureTyped.value = null;
}

/** The handler typing would go to, or null. Reads signals, so components re-render with it. */
export function currentMeasure(): MeasureHandler | null {
  void editor.historyVersion.value;
  const h = measureHandler.value;
  return h && (!h.valid || h.valid()) ? h : null;
}

/** Withdraw a handler (only if it is still the one on offer). */
export function withdrawMeasure(h: MeasureHandler): void {
  if (measureHandler.peek() === h) offerMeasure(null);
}

const TYPED = /^[0-9.,;\-]$/;

/**
 * Keyboard routing: digits, separators and minus start or extend the typed value; once typing,
 * Backspace edits it, Enter applies it and Esc abandons it. Returns true if the key was used.
 */
export function measureKey(e: KeyboardEvent): boolean {
  const h = measureHandler.peek();
  if (!h || (h.valid && !h.valid())) return false;
  const typed = measureTyped.peek();
  if (TYPED.test(e.key)) {
    measureTyped.value = (typed ?? '') + e.key;
    return true;
  }
  if (typed === null) return false;
  if (e.key === 'Backspace') measureTyped.value = typed.slice(0, -1);
  else if (e.key === 'Enter') applyMeasure(typed);
  else if (e.key === 'Escape') measureTyped.value = null;
  else return false;
  return true;
}

/** Apply typed text to the current handler. */
export function applyMeasure(text: string): void {
  const h = measureHandler.peek();
  measureTyped.value = null;
  if (!h || (h.valid && !h.valid()) || !text.trim()) return;
  const err = h.apply(text.trim());
  if (err) showStatus(err, 'error');
}

/** Parse a list of numbers separated by commas or semicolons. Null if any part isn't a number. */
export function parseNumbers(text: string): number[] | null {
  const parts = text.split(/[,;]/).map((s) => s.trim());
  if (!parts.length || parts.some((s) => s === '' || s === '-' || s === '.')) return null;
  const nums = parts.map(Number);
  return nums.every(Number.isFinite) ? nums : null;
}

/**
 * Offer to redo the operation just executed with a typed value. `run` executes the replacement
 * command (and normally offers again). If it fails without executing anything, the original
 * operation is put back. `parse` returns the value, or an error message.
 */
export function offerReplace<V>(label: string, parse: (text: string) => V | string, run: (value: V) => void): void {
  const cmd = editor.history.lastCommand;
  if (!cmd) return;
  offerMeasure({
    label,
    valid: () => editor.history.lastCommand === cmd,
    apply: (text) => {
      const v = parse(text);
      if (typeof v === 'string') return v;
      editor.undo();
      const before = editor.history.lastCommand;
      run(v);
      if (editor.history.lastCommand === before) editor.redo();
    },
  });
}

/** Changing tool ends whatever the box was offering. */
export function installMeasure(): () => void {
  let first = true;
  return effect(() => {
    void activeTool.value;
    if (first) {
      first = false;
      return;
    }
    offerMeasure(null);
  });
}

/** Parse a single number, or explain what's expected. */
export function parseOne(text: string, what = 'a number'): number | string {
  const n = parseNumbers(text);
  return n && n.length === 1 ? n[0]! : `Type ${what}`;
}
