import type { TextureAsset } from '../core/document';

/** Largest texture side kept in documents; bigger images are scaled down on import. */
export const MAX_TEXTURE_SIZE = 2048;

/** Ask the user for an image file. Resolves to null if they cancel. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Read an image file into a texture asset (without an id), scaling it down if it's huge. */
export async function readTexture(file: Blob & { name?: string }): Promise<Omit<TextureAsset, 'id'>> {
  const data = await readAsDataURL(file);
  const img = await loadImage(data);
  const name = file.name ?? 'texture';
  const scale = Math.min(1, MAX_TEXTURE_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1) {
    return { name, mime: file.type || 'image/png', data, width: img.naturalWidth, height: img.naturalHeight };
  }
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
  // Keep transparency for PNG/WebP/GIF; photos stay JPEG.
  const mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return { name, mime, data: canvas.toDataURL(mime, 0.9), width, height };
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Not a readable image'));
    img.src = src;
  });
}
