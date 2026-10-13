const fs = require('node:fs');
const path = require('node:path');

const browserPackages = ['jquery', 'toastr', 'monaco-editor'];
const frontendPackages = [...browserPackages, 'buffer', 'base64-js', 'ieee754'];

function generateLicenses(file, { root = __dirname, packages = frontendPackages } = {}) {
  const notices = ['THIRD-PARTY SOFTWARE NOTICES AND INFORMATION'];
  for (const name of packages) {
    const directory = path.join(root, 'node_modules', name);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const license = typeof pkg.license === 'string' ? pkg.license
      : (pkg.licenses || []).map(item => item.type).join(', ');
    const files = fs.readdirSync(directory).filter(f => /^(licen[cs]e|copying|notice|thirdpartynotices)(\.|$)/i.test(f)).sort();
    let text = files.map(f => fs.readFileSync(path.join(directory, f), 'utf8')).join('\n\n');
    // Toastr publishes its copyright in the source header and links to MIT's terms.
    if (!text && name === 'toastr' && license === 'MIT') {
      const source = fs.readFileSync(path.join(directory, 'toastr.js'), 'utf8');
      const header = source.match(/^\/\*[\s\S]*?\*\//);
      const terms = fs.readFileSync(path.join(root, 'licence'), 'utf8').match(/Permission is hereby granted[\s\S]*/);
      if (header && terms) text = `${header[0]}\n\n${terms[0]}`;
    }
    if (!text) throw new Error(`Missing license text for shipped package ${name}`);
    notices.push(`${pkg.name}@${pkg.version} (${license || 'see license text'})\n\n${text.trim()}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${notices.join('\n\n=========================================\n\n')}\n`);
}

module.exports = { generateLicenses, browserPackages, frontendPackages };
