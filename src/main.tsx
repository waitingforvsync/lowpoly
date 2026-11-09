import { render } from 'preact';
import { App } from './ui/App';
import { installKeymap } from './editor/keymap';
import './ui/styles.css';

render(<App />, document.getElementById('app')!);
installKeymap();
