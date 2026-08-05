#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';

const root = process.cwd();
const localDirectory = path.join(root, 'src/renderer/ds/ui');
const snapshotDirectory = path.join(root, 'scripts/shadcn-registry/new-york-v4');
const lockPath = path.join(root, 'scripts/shadcn-registry-lock.json');
const approvalsPath = path.join(root, 'scripts/shadcn-registry-approvals.json');
const componentsPath = path.join(root, 'components.json');
const pinnedCommit = '607e8a9717fe6ff0d374ba74c651012f9c052534';
const upstreamDirectory = 'apps/v4/registry/new-york-v4/ui';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

const listTsx = async (directory) =>
  (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx'))
    .map((entry) => entry.name)
    .sort();

const listSnapshots = async () =>
  (await readdir(snapshotDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx.upstream'))
    .map((entry) => entry.name.slice(0, -'.upstream'.length))
    .sort();

const snapshotPath = (component) => path.join(snapshotDirectory, `${component}.upstream`);

const isUseClientDirective = (statement) =>
  ts.isExpressionStatement(statement) &&
  ts.isStringLiteral(statement.expression) &&
  statement.expression.text === 'use client';

function normalizeModuleName(moduleName, aliases) {
  if (moduleName === '@/lib/utils' || moduleName === '@/registry/new-york-v4/lib/utils') return aliases.utils;
  if (moduleName.startsWith('@/registry/new-york-v4/ui/')) {
    return `${aliases.ui}/${moduleName.slice('@/registry/new-york-v4/ui/'.length)}`;
  }
  if (moduleName.startsWith('@/registry/new-york-v4/hooks/')) {
    return `${aliases.hooks}/${moduleName.slice('@/registry/new-york-v4/hooks/'.length)}`;
  }
  return moduleName;
}

function canonicalImport(node, aliases) {
  const moduleName = normalizeModuleName(node.moduleSpecifier.text, aliases);
  const clause = node.importClause;
  if (!clause) return [`import:${moduleName}:side-effect`];

  const parts = [];
  if (clause.name) parts.push(`import:${moduleName}:${clause.isTypeOnly ? 'type:' : ''}default:${clause.name.text}`);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    parts.push(`import:${moduleName}:${clause.isTypeOnly ? 'type:' : ''}namespace:${bindings.name.text}`);
  } else if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const isTypeOnly = clause.isTypeOnly || element.isTypeOnly;
      parts.push(`import:${moduleName}:${isTypeOnly ? 'type:' : ''}named:${imported}->${element.name.text}`);
    }
  }
  return parts;
}

function canonicalExport(node) {
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return null;
  const names = node.exportClause.elements
    .map(
      (element) =>
        `${element.isTypeOnly ? 'type:' : ''}${element.propertyName?.text ?? element.name.text}->${element.name.text}`
    )
    .sort();
  const moduleName = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
  return `export:${node.isTypeOnly ? 'type:' : ''}${moduleName}:${names.join(',')}`;
}

function semanticTokens(
  source,
  filename,
  aliases = { utils: '@/renderer/ds/cn', ui: '@/renderer/ds/ui', hooks: '@/renderer/hooks' }
) {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const location = sourceFile.getLineAndCharacterOfPosition(first.start ?? 0);
    throw new Error(
      `${filename}:${location.line + 1}:${location.character + 1}: ${ts.flattenDiagnosticMessageText(first.messageText, '\n')}`
    );
  }

  const imports = [];
  const tokens = [];
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const pushNode = (node) => {
    if (ts.isExportDeclaration(node)) {
      const value = canonicalExport(node);
      if (value) {
        tokens.push({ value, display: value, line: lineOf(node) });
        return;
      }
    }

    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      tokens.push({ value: `identifier:${node.text}`, display: node.text, line: lineOf(node) });
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      tokens.push({ value: `string:${node.text}`, display: JSON.stringify(node.text), line: lineOf(node) });
      return;
    }
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
      tokens.push({ value: `number:${node.text}`, display: node.text, line: lineOf(node) });
      return;
    }
    if (node.kind === ts.SyntaxKind.JsxText) {
      const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
      if (text) tokens.push({ value: `jsx-text:${text}`, display: text, line: lineOf(node) });
      return;
    }

    const children = node.getChildren(sourceFile);
    if (ts.isParenthesizedExpression(node)) {
      pushNode(node.expression);
      return;
    }
    if (children.length === 0) {
      if (
        node.kind !== ts.SyntaxKind.EndOfFileToken &&
        node.kind !== ts.SyntaxKind.SemicolonToken &&
        node.kind !== ts.SyntaxKind.CommaToken
      ) {
        const display = node.getText(sourceFile);
        tokens.push({ value: `token:${node.kind}:${display}`, display, line: lineOf(node) });
      }
      return;
    }
    const nodeName = ts.SyntaxKind[node.kind];
    tokens.push({ value: `node:${nodeName}`, display: `<${nodeName}>`, line: lineOf(node) });
    for (const child of children) pushNode(child);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      for (const value of canonicalImport(statement, aliases)) {
        imports.push({ value, line: lineOf(statement) });
      }
    } else if (!isUseClientDirective(statement)) {
      pushNode(statement);
    }
  }

  return [
    ...imports
      .sort((left, right) => left.value.localeCompare(right.value))
      .map((entry) => ({ ...entry, display: entry.value })),
    ...tokens,
  ];
}

const tokenFingerprint = (tokens) => sha256(tokens.map((token) => token.value).join('\n'));

function findResync(expected, actual, expectedIndex, actualIndex, lookahead = 48) {
  let best = null;
  for (
    let expectedOffset = 0;
    expectedOffset <= lookahead && expectedIndex + expectedOffset < expected.length;
    expectedOffset += 1
  ) {
    for (
      let actualOffset = 0;
      actualOffset <= lookahead && actualIndex + actualOffset < actual.length;
      actualOffset += 1
    ) {
      if (expectedOffset === 0 && actualOffset === 0) continue;
      if (expected[expectedIndex + expectedOffset].value !== actual[actualIndex + actualOffset].value) continue;
      const score = expectedOffset + actualOffset;
      if (!best || score < best.score || (score === best.score && Math.max(expectedOffset, actualOffset) < best.span)) {
        best = { expectedOffset, actualOffset, score, span: Math.max(expectedOffset, actualOffset) };
      }
    }
  }
  return best;
}

function semanticDiff(expected, actual) {
  const hunks = [];
  let expectedIndex = 0;
  let actualIndex = 0;

  while (expectedIndex < expected.length || actualIndex < actual.length) {
    if (
      expectedIndex < expected.length &&
      actualIndex < actual.length &&
      expected[expectedIndex].value === actual[actualIndex].value
    ) {
      expectedIndex += 1;
      actualIndex += 1;
      continue;
    }

    const startExpected = expectedIndex;
    const startActual = actualIndex;
    const resync = findResync(expected, actual, expectedIndex, actualIndex);
    if (resync) {
      expectedIndex += resync.expectedOffset;
      actualIndex += resync.actualOffset;
    } else {
      expectedIndex = Math.min(expected.length, expectedIndex + 48);
      actualIndex = Math.min(actual.length, actualIndex + 48);
    }

    hunks.push({
      upstreamLine: expected[startExpected]?.line ?? expected.at(-1)?.line ?? 1,
      localLine: actual[startActual]?.line ?? actual.at(-1)?.line ?? 1,
      expected: expected.slice(startExpected, expectedIndex).map((token) => token.display),
      actual: actual.slice(startActual, actualIndex).map((token) => token.display),
    });
  }
  return hunks;
}

function validateApprovalsDocument(document) {
  assert.equal(document.version, 1, 'approval manifest version must be 1');
  assert(Array.isArray(document.approvals), 'approval manifest approvals must be an array');
  const keys = new Set();
  for (const approval of document.approvals) {
    assert.deepEqual(
      Object.keys(approval).sort(),
      ['component', 'localSemanticSha256', 'reason', 'upstreamSha256'].sort(),
      `approval for ${approval.component ?? '<unknown>'} must contain only the exact approval fields`
    );
    assert(/^[a-z0-9-]+\.tsx$/.test(approval.component), `invalid approval component: ${approval.component}`);
    assert(/^[a-f0-9]{64}$/.test(approval.upstreamSha256), `invalid upstream hash for ${approval.component}`);
    assert(/^[a-f0-9]{64}$/.test(approval.localSemanticSha256), `invalid local hash for ${approval.component}`);
    assert(approval.reason.trim().length > 0, `approval for ${approval.component} requires a reason`);
    assert(!keys.has(approval.component), `duplicate approval for ${approval.component}`);
    keys.add(approval.component);
  }
}

const approvalMatches = (approval, component, upstreamSha256, localSemanticSha256) =>
  approval?.component === component &&
  approval.upstreamSha256 === upstreamSha256 &&
  approval.localSemanticSha256 === localSemanticSha256;

async function createLock() {
  const files = await listSnapshots();
  const components = [];
  for (const file of files) {
    const source = await readFile(snapshotPath(file), 'utf8');
    components.push({ file, sha256: sha256(source) });
  }
  return {
    version: 1,
    registry: 'new-york-v4',
    primitive: 'radix',
    repository: 'https://github.com/shadcn-ui/ui',
    commit: pinnedCommit,
    upstreamDirectory,
    components,
  };
}

async function writeLock() {
  const lock = await createLock();
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`wrote ${path.relative(root, lockPath)} with ${lock.components.length} pinned components`);
}

function runSelfTest() {
  const official = `
"use client"
import * as React from "react"
import { cn } from "@/lib/utils"
export function Example() { return <button className={cn("bg-primary")}>Open</button> }
export { Example as StockExample, Example }
`;
  const formattingOnly = `
import { cn } from '@/renderer/ds/cn';
import * as React from 'react';
export function Example() {
  return <button className={cn('bg-primary')}>Open</button>;
}
export { Example, Example as StockExample };
`;
  const behaviorChange = formattingOnly.replace('bg-primary', 'bg-destructive');
  const officialTokens = semanticTokens(official, 'example.tsx');
  const formattingTokens = semanticTokens(formattingOnly, 'example.tsx');
  const behaviorTokens = semanticTokens(behaviorChange, 'example.tsx');
  assert.equal(tokenFingerprint(officialTokens), tokenFingerprint(formattingTokens));
  assert.notEqual(tokenFingerprint(officialTokens), tokenFingerprint(behaviorTokens));
  assert.equal(semanticDiff(officialTokens, formattingTokens).length, 0);
  assert(semanticDiff(officialTokens, behaviorTokens).length > 0);
  assert.throws(
    () =>
      validateApprovalsDocument({
        version: 1,
        approvals: [
          {
            component: 'example.tsx',
            upstreamSha256: 'a'.repeat(64),
            localSemanticSha256: 'b'.repeat(64),
            reason: '',
          },
        ],
      }),
    /requires a reason/
  );
  const exactApproval = {
    component: 'example.tsx',
    upstreamSha256: 'a'.repeat(64),
    localSemanticSha256: 'b'.repeat(64),
    reason: 'Reviewed integration requirement',
  };
  assert(approvalMatches(exactApproval, 'example.tsx', 'a'.repeat(64), 'b'.repeat(64)));
  assert(!approvalMatches(exactApproval, 'example.tsx', 'a'.repeat(64), 'c'.repeat(64)));
  console.log('shadcn registry drift checker self-test passed');
}

async function inspectRegistry() {
  const [components, packageJson, lock, approvalsDocument, localFiles, snapshotFiles] = await Promise.all([
    readJson(componentsPath),
    readJson(path.join(root, 'package.json')),
    readJson(lockPath),
    readJson(approvalsPath),
    listTsx(localDirectory),
    listSnapshots(),
  ]);

  const infrastructure = [];
  if (components.style !== 'new-york')
    infrastructure.push(`components.json style is ${components.style}, expected new-york`);
  if (components.rsc !== false)
    infrastructure.push('components.json rsc must remain false for the renderer normalization');
  if (!packageJson.dependencies?.['radix-ui'])
    infrastructure.push('package.json must retain the radix-ui primitive dependency');
  if (lock.version !== 1) infrastructure.push(`unsupported lock version: ${lock.version}`);
  if (lock.registry !== 'new-york-v4' || lock.primitive !== 'radix') {
    infrastructure.push(`lock targets ${lock.registry}/${lock.primitive}, expected new-york-v4/radix`);
  }
  if (lock.commit !== pinnedCommit) infrastructure.push(`lock commit is ${lock.commit}, expected ${pinnedCommit}`);
  if (lock.upstreamDirectory !== upstreamDirectory)
    infrastructure.push('lock upstream directory does not match the checker');

  try {
    validateApprovalsDocument(approvalsDocument);
  } catch (error) {
    infrastructure.push(error.message);
  }
  const approvals = Array.isArray(approvalsDocument.approvals)
    ? approvalsDocument.approvals.filter((approval) => approval && typeof approval === 'object')
    : [];

  const lockEntries = new Map(lock.components.map((component) => [component.file, component]));
  const localSet = new Set(localFiles);
  const snapshotSet = new Set(snapshotFiles);
  const componentNames = [...new Set([...localFiles, ...snapshotFiles, ...lockEntries.keys()])].sort();
  const drift = [];

  for (const component of componentNames) {
    const entry = lockEntries.get(component);
    if (!entry) {
      infrastructure.push(`${component}: snapshot or local component is missing from the registry lock`);
      continue;
    }
    if (!snapshotSet.has(component)) {
      infrastructure.push(`${component}: pinned snapshot is missing`);
      continue;
    }
    const upstreamSource = await readFile(snapshotPath(component), 'utf8');
    const upstreamSha256 = sha256(upstreamSource);
    if (entry.sha256 !== upstreamSha256) {
      infrastructure.push(`${component}: pinned snapshot hash differs from the registry lock`);
      continue;
    }
    if (!localSet.has(component)) {
      drift.push({
        component,
        localPath: `src/renderer/ds/ui/${component}`,
        status: 'missing-local',
        deferred: component === 'sidebar.tsx',
        approved: false,
        upstreamSha256,
        localSemanticSha256: null,
        hunks: [],
      });
      continue;
    }

    const localSource = await readFile(path.join(localDirectory, component), 'utf8');
    const upstreamTokens = semanticTokens(upstreamSource, component, components.aliases);
    const localTokens = semanticTokens(localSource, component, components.aliases);
    const upstreamSemanticSha256 = tokenFingerprint(upstreamTokens);
    const localSemanticSha256 = tokenFingerprint(localTokens);
    if (upstreamSemanticSha256 === localSemanticSha256) continue;

    const approval = approvals.find((candidate) => candidate.component === component);
    const approved = approvalMatches(approval, component, upstreamSha256, localSemanticSha256);
    drift.push({
      component,
      localPath: `src/renderer/ds/ui/${component}`,
      status: 'drift',
      deferred: component === 'sidebar.tsx',
      approved,
      approvalReason: approved ? approval.reason : undefined,
      upstreamSha256,
      upstreamSemanticSha256,
      localSemanticSha256,
      hunks: semanticDiff(upstreamTokens, localTokens),
    });
  }

  const driftNames = new Set(drift.map((entry) => entry.component));
  for (const approval of approvals) {
    if (!driftNames.has(approval.component)) {
      infrastructure.push(`${approval.component}: stale approval; the component no longer drifts`);
    } else if (!drift.find((entry) => entry.component === approval.component)?.approved) {
      infrastructure.push(`${approval.component}: stale approval hashes; review the changed drift again`);
    }
  }

  return {
    pin: {
      registry: lock.registry,
      primitive: lock.primitive,
      commit: lock.commit,
      repository: lock.repository,
      components: lock.components.length,
    },
    normalization: [
      'rsc:false use-client directive',
      `utils alias -> ${components.aliases.utils}`,
      `ui alias -> ${components.aliases.ui}`,
      `hooks alias -> ${components.aliases.hooks}`,
      'formatting/import/export order',
    ],
    infrastructure,
    drift,
    counts: {
      checked: componentNames.length,
      stock: componentNames.length - drift.length,
      drifted: drift.length,
      approved: drift.filter((entry) => entry.approved).length,
      deferred: drift.filter((entry) => entry.deferred).length,
      unapproved: drift.filter((entry) => !entry.approved).length,
      hunks: drift.reduce((total, entry) => total + entry.hunks.length, 0),
    },
  };
}

const clip = (values, max = 180) => {
  const text = values.join(' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || '<nothing>';
};

function printSummary(report) {
  console.log(
    `shadcn registry: ${report.counts.stock}/${report.counts.checked} stock; ${report.counts.unapproved} unapproved drift; ${report.counts.approved} approved; ${report.counts.hunks} semantic hunks`
  );
  console.log(`pin: ${report.pin.registry}/${report.pin.primitive} @ ${report.pin.commit}`);
  for (const entry of report.drift) {
    const state = entry.deferred ? 'DEFERRED' : entry.approved ? 'APPROVED' : 'DRIFT';
    console.log(`${state} ${entry.localPath} (${entry.hunks.length} hunks)`);
  }
  for (const violation of report.infrastructure) console.error(`INFRASTRUCTURE ${violation}`);
}

function printFull(report) {
  printSummary(report);
  for (const entry of report.drift) {
    console.log(`\n${entry.localPath}`);
    console.log(`  upstream sha256: ${entry.upstreamSha256}`);
    console.log(`  local semantic sha256: ${entry.localSemanticSha256 ?? '<missing>'}`);
    if (entry.approvalReason) console.log(`  approved: ${entry.approvalReason}`);
    if (!entry.approved && entry.localSemanticSha256) {
      console.log('  exact approval key (reason intentionally omitted):');
      console.log(
        `    { "component": "${entry.component}", "upstreamSha256": "${entry.upstreamSha256}", "localSemanticSha256": "${entry.localSemanticSha256}" }`
      );
    }
    for (const [index, hunk] of entry.hunks.entries()) {
      console.log(`  hunk ${index + 1}: upstream:${hunk.upstreamLine} local:${hunk.localLine}`);
      console.log(`    - ${clip(hunk.expected)}`);
      console.log(`    + ${clip(hunk.actual)}`);
    }
  }
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else if (process.argv.includes('--write-lock')) {
  await writeLock();
} else {
  const formatArgument = process.argv.find((argument) => argument.startsWith('--format='));
  const format =
    formatArgument?.split('=')[1] ??
    (process.argv.includes('--json') ? 'json' : process.argv.includes('--summary') ? 'summary' : 'full');
  if (!['full', 'summary', 'json'].includes(format)) throw new Error(`unknown output format: ${format}`);
  const report = await inspectRegistry();
  if (format === 'json') console.log(JSON.stringify(report, null, 2));
  else if (format === 'summary') printSummary(report);
  else printFull(report);
  if (report.infrastructure.length > 0) process.exitCode = 2;
  else if (report.counts.unapproved > 0) process.exitCode = 1;
}
