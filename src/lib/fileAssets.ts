export async function loadImageFile(file: File): Promise<{ image: HTMLImageElement; url: string }> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose a PNG, JPG, WebP, GIF, or SVG image.");
  }

  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();
  return { image, url };
}

export function revokeUrl(url?: string) {
  if (url) URL.revokeObjectURL(url);
}
