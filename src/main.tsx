import { render } from 'preact';
import { effect } from '@preact/signals';
import { App } from './ui/App';
import { installKeymap } from './editor/keymap';
import { editor } from './editor/editor';
import './ui/styles.css';

render(<App />, document.getElementById('app')!);
installKeymap();

effect(() => {
  void editor.historyVersion.value;
  document.title = `${editor.isDirty ? '● ' : ''}${editor.fileName.value} — Lowpoly`;
});
