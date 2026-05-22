const fs = require('fs');
const path = require('path');

const dir = __dirname;
const modules = [
  '01-intro',
  '02-idea',
  '03-mvp',
  '04-launch',
  '05-scale',
  '06-stories',
];

function cleanMarkdown(md) {
  md = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  md = md.replace(/<picture[\s\S]*?<\/picture>/gi, '');
  md = md.replace(/^\s*<\/?(picture|source|img|a\s+id)[^>]*>\s*$/gim, '');
  md = md.replace(/\[!\[.*?\]\(https:\/\/img\.shields\.io.*?\)\]\(.*?\)\n?/g, '');
  md = md.replace(/\[!\[.*?\]\(https:\/\/api\.star-history\.com.*?\)\]\(.*?\)\n?/g, '');
  md = md.replace(/^!\[.*?\]\(.*?\)\s*$/gm, '');
  md = md.replace(/^\n+/, '');
  return md;
}

const data = { zh: {}, en: {} };

for (const m of modules) {
  const zhFile = path.join(dir, `${m}.md`);
  if (fs.existsSync(zhFile)) {
    data.zh[m] = cleanMarkdown(fs.readFileSync(zhFile, 'utf8'));
  }
  const enFile = path.join(dir, 'en', `${m}.md`);
  if (fs.existsSync(enFile)) {
    data.en[m] = cleanMarkdown(fs.readFileSync(enFile, 'utf8'));
  }
}

const js = `// Auto-generated bilingual course data for "Claude 教你创业" (The Founder's Playbook)
// Source: Anthropic — https://claude.com/blog/the-founders-playbook
// Do not edit manually. Run: node courses/founders-playbook/build.js
const COURSE_DATA = ${JSON.stringify(data, null, 0)};
`;

fs.writeFileSync(path.join(dir, 'modules.js'), js, 'utf8');
console.log(`Generated modules.js: ${fs.statSync(path.join(dir, 'modules.js')).size} bytes`);
console.log(`  zh modules: ${Object.keys(data.zh).length}`);
console.log(`  en modules: ${Object.keys(data.en).length}`);
