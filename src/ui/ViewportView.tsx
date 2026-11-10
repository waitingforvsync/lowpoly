import { useEffect, useRef } from 'preact/hooks';
import { Viewport } from '../render/Viewport';
import { attachViewport } from '../editor/viewActions';
import { importOBJFiles } from '../io/exchange';

export function ViewportView() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vp = new Viewport(ref.current!);
    attachViewport(vp);
    return () => {
      attachViewport(null);
      vp.dispose();
    };
  }, []);

  // Drop an .obj (with its .mtl and images) onto the viewport to import it.
  return (
    <main
      class="viewport"
      ref={ref}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = [...(e.dataTransfer?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        void importOBJFiles(files);
      }}
    />
  );
}
