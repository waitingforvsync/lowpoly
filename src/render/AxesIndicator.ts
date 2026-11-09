import * as THREE from 'three';
import { COLORS } from './colors';

/** Small orientation indicator drawn in the bottom-left corner of the viewport. */
export class AxesIndicator {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  private readonly disposables: { dispose(): void }[] = [];

  constructor(private readonly sizePx = 84) {
    const axes: [THREE.Vector3, number, string][] = [
      [new THREE.Vector3(1, 0, 0), COLORS.axisX, 'X'],
      [new THREE.Vector3(0, 1, 0), COLORS.axisY, 'Y'],
      [new THREE.Vector3(0, 0, 1), COLORS.axisZ, 'Z'],
    ];
    for (const [dir, color, label] of axes) {
      const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir]);
      const material = new THREE.LineBasicMaterial({ color });
      this.scene.add(new THREE.Line(geometry, material));

      const sprite = makeLabel(label, color);
      sprite.position.copy(dir).multiplyScalar(1.3);
      this.scene.add(sprite);
      this.disposables.push(geometry, material, sprite.material, sprite.material.map!);
    }
  }

  render(renderer: THREE.WebGLRenderer, mainCamera: THREE.Camera): void {
    // Look at the origin from the same direction as the main camera.
    this.camera.quaternion.copy(mainCamera.quaternion);
    this.camera.position.set(0, 0, 4).applyQuaternion(mainCamera.quaternion);
    this.camera.updateMatrixWorld();

    const s = this.sizePx;
    renderer.setScissorTest(true);
    renderer.setScissor(8, 8, s, s);
    renderer.setViewport(8, 8, s, s);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function makeLabel(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.fillText(text, 32, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.scale.setScalar(0.6);
  return sprite;
}
