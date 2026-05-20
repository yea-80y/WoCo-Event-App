export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export interface CompressOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

// Canvas-based image compression. Downscales to maxWidth/maxHeight (never upscales),
// outputs WebP where supported, JPEG otherwise. SVG and GIF are passed through unchanged.
export async function compressImage(file: File, opts: CompressOptions = {}): Promise<string> {
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
    return fileToBase64(file);
  }
  const { maxWidth = 1920, maxHeight = 1080, quality = 0.85 } = opts;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(maxWidth / img.naturalWidth, maxHeight / img.naturalHeight, 1);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas not available')); return; }
      ctx.drawImage(img, 0, 0, w, h);
      const webp = canvas.toDataURL('image/webp', quality);
      resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality));
    };

    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Image load failed')); };
    img.src = objectUrl;
  });
}

// Named presets so callers stay readable.
export const imgPreset = {
  eventCover:  { maxWidth: 1400, maxHeight: 900,  quality: 0.85 } satisfies CompressOptions,
  logo:        { maxWidth: 600,  maxHeight: 600,  quality: 0.88 } satisfies CompressOptions,
  siteImage:   { maxWidth: 1800, maxHeight: 1200, quality: 0.85 } satisfies CompressOptions,
} as const;
