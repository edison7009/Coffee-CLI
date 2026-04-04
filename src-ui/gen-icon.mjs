import sharp from 'sharp';

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="220" ry="220" fill="#161412" />
  <g transform="translate(128, 140) scale(32)">
    <!-- Steam -->
    <g fill="none" stroke="#C4956A" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5">
      <path d="M8 2 c 0 1.5 -2 1.5 -2 3 s 2 1.5 2 3 M12 2 c 0 1.5 -2 1.5 -2 3 s 2 1.5 2 3 M16 2 c 0 1.5 -2 1.5 -2 3 s 2 1.5 2 3" />
    </g>
    
    <!-- Cup Body (Outline) -->
    <path fill="none" stroke="#C4956A" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" 
          d="M17 11v6.5c0 1.66 -1.34 3 -3 3h-6c-1.66 0 -3 -1.34 -3 -3v-6.5Z" />
          
    <!-- Handle -->
    <path fill="none" stroke="#C4956A" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" 
          d="M17 11h2.5c1 0 1.5 0.7 1.5 1.5v1.5c0 0.8 -0.5 1.5 -1.5 1.5h-2.5" />
  </g>
</svg>`;

sharp(Buffer.from(svg))
  .png()
  .toFile('../logo.png')
  .then(() => console.log('Done!'))
  .catch((err) => console.error(err));
