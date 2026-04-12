const fs = require('fs');
const path = require('path');

const dir = __dirname;
const modules = [
  '01-slash-commands',
  '02-memory',
  '03-skills',
  '04-subagents',
  '05-mcp',
  '06-hooks',
  '07-plugins',
  '08-checkpoints',
  '09-advanced-features',
  '10-cli',
];

// Clean HTML noise from source markdown before packaging
function cleanMarkdown(md) {
  // Remove <picture>...</picture> blocks (multi-line)
  md = md.replace(/<picture[\s\S]*?<\/picture>/gi, '');
  // Remove standalone HTML tag lines (<source>, <img>, <a id="...">, etc.)
  md = md.replace(/^\s*<\/?(picture|source|img|a\s+id)[^>]*>\s*$/gim, '');
  // Remove badge image lines
  md = md.replace(/\[!\[.*?\]\(https:\/\/img\.shields\.io.*?\)\]\(.*?\)\n?/g, '');
  md = md.replace(/\[!\[.*?\]\(https:\/\/api\.star-history\.com.*?\)\]\(.*?\)\n?/g, '');
  // Remove markdown image lines (![](..))
  md = md.replace(/^!\[.*?\]\(.*?\)\s*$/gm, '');
  // Remove leading blank lines
  md = md.replace(/^\n+/, '');
  return md;
}

// Build bilingual data: { zh: { moduleId: content }, en: { moduleId: content } }
const data = { zh: {}, en: {} };

for (const m of modules) {
  // Chinese version (root .md files)
  const zhFile = path.join(dir, `${m}.md`);
  if (fs.existsSync(zhFile)) {
    data.zh[m] = cleanMarkdown(fs.readFileSync(zhFile, 'utf8'));
  }

  // English version (en/ subdirectory)
  const enFile = path.join(dir, 'en', `${m}.md`);
  if (fs.existsSync(enFile)) {
    data.en[m] = cleanMarkdown(fs.readFileSync(enFile, 'utf8'));
  }
}

const js = `// Auto-generated bilingual course data from luongnv89/claude-howto (MIT License)
// Do not edit manually. Run: node courses/claude-code/build.js
const COURSE_DATA = ${JSON.stringify(data, null, 0)};
`;

fs.writeFileSync(path.join(dir, 'modules.js'), js, 'utf8');
console.log(`Generated modules.js: ${fs.statSync(path.join(dir, 'modules.js')).size} bytes`);
console.log(`  zh modules: ${Object.keys(data.zh).length}`);
console.log(`  en modules: ${Object.keys(data.en).length}`);
