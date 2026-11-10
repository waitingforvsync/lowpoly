import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { editor } from '../editor/editor';
import { componentSelection, editObjects, selectedObjects } from '../editor/selection';
import { selectionMode, showTextures, uvPanelOpen } from '../editor/state';
import { UVView } from '../render/UVView';

/** The UV editor panel, docked to the right of the viewport. */
export function UVPanel() {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<UVView | null>(null);

  useEffect(() => {
    const v = new UVView(host.current!);
    view.current = v;
    const stop = effect(() => {
      void editor.docVersion.value;
      void selectionMode.value;
      void componentSelection.face.value;
      void editObjects.value;
      void selectedObjects.value;
      v.update(showTextures.value);
    });
    return () => {
      stop();
      v.dispose();
      view.current = null;
    };
  }, []);

  return (
    <section class="uv-panel" aria-label="UV editor">
      <header class="panel-title uv-header">
        <span>UV Editor</span>
        <span class="uv-actions">
          <button type="button" class="tb-button uv-btn" title="Frame the UVs shown" onClick={() => view.current?.fit()}>
            Fit
          </button>
          <button type="button" class="tb-button uv-btn" title="Close the UV editor" onClick={() => (uvPanelOpen.value = false)}>
            ×
          </button>
        </span>
      </header>
      <div class="uv-canvas" ref={host} />
      <p class="uv-help">
        In repeats of the texture. Face mode: drag selected faces to move their UVs (snaps to the grid step). Wheel zooms;
        middle or right drag pans.
      </p>
    </section>
  );
}
