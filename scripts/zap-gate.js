#!/usr/bin/env node
'use strict';
// Gate for the OWASP ZAP baseline scan (PLAN §6: "ZAP baseline clean of high/medium").
//   node scripts/zap-gate.js report_json.json .zap/rules.tsv
// Fails when the report holds a High (3) or Medium (2) risk alert, unless .zap/rules.tsv marks that rule IGNORE
// (a reviewed, justified acceptance). A rule marked FAIL fails at any risk level. Low/Informational alerts are listed.
const fs = require('node:fs');

const [reportFile = 'report_json.json', rulesFile = '.zap/rules.tsv'] = process.argv.slice(2);
if (!fs.existsSync(reportFile)) { console.error(`zap-gate: ${reportFile} not found (did the scan run?)`); process.exit(1); }

const rules = new Map(); // pluginid -> { action, why }
for (const line of fs.readFileSync(rulesFile, 'utf8').split(/\r?\n/)) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [id, action, why = ''] = line.split('\t');
  if (!/^\d+$/.test(id) || !['IGNORE', 'WARN', 'FAIL', 'INFO', 'OUTOFSCOPE'].includes(action)) {
    console.error(`zap-gate: malformed rules line: ${JSON.stringify(line)}`); process.exit(1);
  }
  if (action === 'IGNORE' && why.trim().length < 20) {
    console.error(`zap-gate: IGNORE for ${id} needs a written justification in the third column`); process.exit(1);
  }
  rules.set(id, { action, why: why.trim() });
}

const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const RISK = { 3: 'High', 2: 'Medium', 1: 'Low', 0: 'Informational' };
const failing = []; const accepted = []; const other = [];
for (const site of report.site || []) {
  for (const a of site.alerts || []) {
    const id = String(a.pluginid);
    const risk = Number(a.riskcode);
    const rule = rules.get(id);
    const row = `${RISK[risk] || risk}  ${id}  ${a.name || a.alert}  (${a.count || (a.instances || []).length} instance(s), ${site['@name']})`;
    if (rule && rule.action === 'FAIL') failing.push(row);
    else if (risk >= 2 && rule && (rule.action === 'IGNORE' || rule.action === 'OUTOFSCOPE')) accepted.push(`${row}\n      accepted: ${rule.why}`);
    else if (risk >= 2) failing.push(row);
    else other.push(row);
  }
}
if (accepted.length) console.log(`Accepted (reviewed in ${rulesFile}):\n  ${accepted.join('\n  ')}`);
if (other.length) console.log(`Low / informational:\n  ${other.join('\n  ')}`);
if (failing.length) {
  console.error(`ZAP gate FAILED: ${failing.length} high/medium (or FAIL-listed) alert(s):\n  ${failing.join('\n  ')}`);
  process.exit(1);
}
console.log('ZAP gate passed: no unreviewed high or medium alerts.');
