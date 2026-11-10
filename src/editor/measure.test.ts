import { describe, expect, it } from 'vitest';
import { FnCommand } from '../history/history';
import { editor } from './editor';
import { applyMeasure, measureHandler, offerReplace, parseNumbers, parseOne } from './measure';

describe('parseNumbers', () => {
  it('reads one or more numbers separated by commas or semicolons', () => {
    expect(parseNumbers('2.5')).toEqual([2.5]);
    expect(parseNumbers('1, -2;3')).toEqual([1, -2, 3]);
    expect(parseNumbers('-.5')).toEqual([-0.5]);
  });

  it('rejects anything that is not a number', () => {
    for (const t of ['', '-', '1,', 'a', '1,,2', '.']) expect(parseNumbers(t)).toBeNull();
    expect(parseOne('1,2')).toBe('Type a number');
  });
});

describe('offerReplace', () => {
  /** A counter changed by commands, standing in for the document. */
  function setup() {
    let value = 0;
    const run = (v: number) => {
      const before = value;
      editor.execute(new FnCommand('Set', () => (value = v), () => (value = before)));
    };
    return { get: () => value, run };
  }

  it('replaces the last operation with one using the typed value', () => {
    const s = setup();
    s.run(1);
    const offer = () =>
      offerReplace('Value', (t) => parseOne(t), (v) => {
        s.run(v);
        offer();
      });
    offer();
    applyMeasure('5');
    expect(s.get()).toBe(5);
    applyMeasure('7'); // still the last operation, so it is replaced again
    expect(s.get()).toBe(7);
    editor.undo();
    expect(s.get()).toBe(0); // one undo step, as if 7 had been dragged to directly
  });

  it('stops applying once something else has been done', () => {
    const s = setup();
    s.run(1);
    offerReplace('Value', (t) => parseOne(t), (v) => s.run(v));
    s.run(2);
    applyMeasure('5');
    expect(s.get()).toBe(2);
  });

  it('puts the original back if the replacement fails, and keeps it on a parse error', () => {
    const s = setup();
    s.run(3);
    offerReplace('Value', (t) => parseOne(t), () => {
      /* fails without executing anything */
    });
    applyMeasure('9');
    expect(s.get()).toBe(3);
    expect(editor.history.lastCommand?.label).toBe('Set');
    offerReplace('Value', (t) => parseOne(t), (v) => s.run(v));
    applyMeasure('x');
    expect(s.get()).toBe(3);
    measureHandler.value = null;
  });
});
