const fs = require('fs');
const path = require('path');

const files = [
  'src/commands/abwesenheit.js',
  'src/commands/admin.js',
  'src/commands/ping.js',
  'src/commands/profil.js',
  'src/commands/regel.js',
  'src/commands/spieltermin.js',
  'src/commands/urlaub.js',
  'src/index.js',
  'src/utils/permissions.js'
];

function addMessageFlagsImport(source, file) {
  if (!source.includes('MessageFlags.Ephemeral')) return source;
  if (source.includes('MessageFlags')) return source;

  const requireRegex = /const\s*{([\s\S]*?)}\s*=\s*require\('discord\.js'\);/m;
  const match = source.match(requireRegex);

  if (!match) {
    console.log(`[WARN] Kein discord.js-Destructuring-Import gefunden in ${file}`);
    return source;
  }

  const fullMatch = match[0];
  const inner = match[1];

  let replacement;

  if (inner.includes('\n')) {
    const trimmed = inner.replace(/\s*$/, '');
    replacement = `const {${trimmed},\n  MessageFlags\n} = require('discord.js');`;
  } else {
    const parts = inner
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    parts.push('MessageFlags');
    replacement = `const { ${parts.join(', ')} } = require('discord.js');`;
  }

  return source.replace(fullMatch, replacement);
}

for (const file of files) {
  const abs = path.join(process.cwd(), file);

  if (!fs.existsSync(abs)) {
    console.log(`[SKIP] Nicht gefunden: ${file}`);
    continue;
  }

  let source = fs.readFileSync(abs, 'utf8');
  const before = source;

  source = source.replace(/ephemeral\s*:\s*true/g, 'flags: MessageFlags.Ephemeral');
  source = source.replace(/ephemeral\s*:\s*false\s*,?/g, '');
  source = addMessageFlagsImport(source, file);

  if (source !== before) {
    fs.writeFileSync(abs, source, 'utf8');
    console.log(`[FIXED] ${file}`);
  } else {
    console.log(`[OK] ${file}`);
  }
}