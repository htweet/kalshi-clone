'use strict';
// Prints each ESLint error with the source around its column (a review aid for bulk rewrites).
const { ESLint } = require('eslint');
const fs = require('node:fs');

(async () => {
  const eslint = new ESLint({ cwd: `${__dirname}/..` });
  const results = await eslint.lintFiles(process.argv.slice(2).length ? process.argv.slice(2) : ['public']);
  for (const r of results) {
    if (!r.messages.length) continue;
    const lines = fs.readFileSync(r.filePath, 'utf8').split('\n');
    for (const m of r.messages) {
      const l = lines[m.line - 1] || '';
      console.log(`${r.filePath.replace(/.*clone\//, '')}:${m.line}:${m.column} ${m.ruleId}\n    ${l.slice(Math.max(0, m.column - 120), m.column + 80)}`);
    }
  }
})();
