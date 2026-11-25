import sharp from 'sharp';
import path from 'path';

const iconPath = path.resolve('../icons/icon.png');
const outPath = path.resolve('../icons/icon_new.png');

async function processIcon() {
  const meta = await sharp(iconPath).metadata();
  console.log(`Original size: ${meta.width}x${meta.height}`);

  // 放大 1.5 倍（相当于裁切中间的一小块，再放大回原图尺寸）
  const zoom = 1.5;
  const cropWidth = Math.floor(meta.width / zoom);
  const cropHeight = Math.floor(meta.height / zoom);

  const left = Math.floor((meta.width - cropWidth) / 2);
  const top = Math.floor((meta.height - cropHeight) / 2);

  await sharp(iconPath)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(meta.width, meta.height)
    .toFile(outPath);

  console.log('Done zooming icon!');
}
processIcon();
