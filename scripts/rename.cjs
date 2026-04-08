const fs = require('fs');
const path = require('path');

function processDirectory(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === 'node_modules' || file === '.git' || file === 'dist' || file.includes('bun.lock')) continue;
    
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      processDirectory(fullPath);
    } else {
      const ext = path.extname(fullPath);
      if (['.ts', '.json', '.md', '.tsx', '.toml'].includes(ext)) {
        try {
            let content = fs.readFileSync(fullPath, 'utf8');
            let newContent = content
              .replace(/opencode/g, 'coffeecode')
              .replace(/OpenCode/g, 'CoffeeCode')
              .replace(/OPENCODE/g, 'COFFEECODE');
              
            if (content !== newContent) {
              fs.writeFileSync(fullPath, newContent, 'utf8');
              console.log("Updated " + fullPath);
            }
        } catch (e) {
            // ignore
        }
      }
    }
  }
}

// target dirs
const dirs = ['packages/opencode', 'packages/cli', 'scripts', 'docs', '.'];
for (const d of dirs) {
    const full = path.join(__dirname, d);
    if (fs.existsSync(full)) {
        processDirectory(full);
    }
}
console.log('Done replacement');
