import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';

const rendererRoot = path.resolve('src/renderer');
const sourceExtensions = new Set(['.ts', '.tsx', '.css']);
const reportMode = process.argv.includes('--json') ? 'json' : process.argv.includes('--summary') ? 'summary' : 'full';

const exceptionConfig = JSON.parse(await readFile('scripts/shadcn-boundary-exceptions.json', 'utf8'));
const excludedFiles = new Map(exceptionConfig.excludedFiles.map((entry) => [entry.path, entry.reason]));
const approvedViolations = exceptionConfig.approvedViolations ?? [];

const ruleDescriptions = {
  'arbitrary-property': 'Replace arbitrary Tailwind properties with idiomatic utilities or a shadcn component variant.',
  'arbitrary-value': 'Arbitrary Tailwind values require explicit review; prefer theme-backed utilities.',
  'inline-style': 'Inline styles require explicit review; prefer utilities, variants, or semantic CSS.',
  'dom-style-mutation': 'Direct DOM style mutation bypasses shadcn variants and must be explicitly reviewed.',
  'styles-map': 'Griffel-shaped styles maps must be migrated to direct utilities or an explicit component variant.',
  'hardcoded-color': 'UI colors must come from shadcn semantic tokens, not color literals.',
  'tailwind-palette-color': 'Tailwind palette colors are fixed paint; use shadcn semantic color utilities.',
  'non-shadcn-color-token':
    'This color token is outside the approved shadcn semantic palette and requires user approval.',
  'legacy-ui-vocabulary': 'Fluent/Griffel compatibility vocabulary is forbidden.',
  'compatibility-component': 'Compatibility component wrappers obscure the strict shadcn migration.',
  'third-party-theme-override':
    'Application CSS must not override Yoopta UI selectors; use the official @yoopta/ui and @yoopta/themes-shadcn defaults.',
};

const patterns = {
  arbitraryProperty: /\[(?:-?[a-zA-Z][\w-]*|--[\w-]+):[^\]\n]+\]/g,
  arbitraryValue: /(?<![\w-])[a-zA-Z][\w-]*-\[[^\]\n]+\]/g,
  hardcodedColor: /#[\da-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|color-mix)\(/g,
  paletteColor:
    /\b(?:bg|text|border|outline|ring|fill|stroke|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-\d{2,3})?(?:\/\d+)?\b/g,
  nonShadcnToken: /--(?:info|info-foreground|danger|danger-foreground)\b/g,
  legacyCssToken: /--color(?:Neutral|Brand|Palette)[\w-]*|--shadow(?:2|4|8|16|28|64)\b/gi,
};

const classCallNames = new Set(['cn', 'clsx', 'classNames', 'cva', 'tv', 'twJoin', 'twMerge']);
const paintPropertyNames = new Set([
  'accentColor',
  'background',
  'backgroundColor',
  'border',
  'borderBottomColor',
  'borderColor',
  'borderLeftColor',
  'borderRightColor',
  'borderTopColor',
  'boxShadow',
  'caretColor',
  'color',
  'fill',
  'floodColor',
  'outline',
  'outlineColor',
  'stroke',
  'stopColor',
  'textDecorationColor',
]);
const paintVariablePattern = /(?:colors?|colours?|paint|palette|theme)$/i;
const paintCssPropertyPattern =
  /(?:^|-)(?:accent-color|background|border|box-shadow|caret-color|color|fill|flood-color|outline|stroke|text-decoration-color)(?:-|$)/;
const approvedThemePaintTokens = new Set([
  '--accent',
  '--accent-foreground',
  '--background',
  '--border',
  '--card',
  '--card-foreground',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--destructive',
  '--destructive-foreground',
  '--foreground',
  '--input',
  '--muted',
  '--muted-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--ring',
  '--secondary',
  '--secondary-foreground',
  '--sidebar',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-ring',
  '--success',
  '--success-foreground',
  '--warning',
  '--warning-foreground',
]);
const ignoredArbitraryVariantPattern =
  /^(?:aria|data|group|peer|has|not|supports|group-data|peer-data|group-aria|peer-aria)-\[/;
const radixGeometryVariablePattern =
  /^--radix-[a-z0-9-]+-(?:width|height|available-width|available-height|transform-origin)$/;

const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(absolute);
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(absolute);
    }
  }
}

function sourceLine(text, position) {
  const start = text.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const endIndex = text.indexOf('\n', position);
  const end = endIndex === -1 ? text.length : endIndex;
  return text.slice(start, end).trim().slice(0, 240);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function shouldScanBoundaryFile(file) {
  return !file.startsWith('src/renderer/ds/ui/');
}

function locationOf(sourceFile, position) {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: location.line + 1, column: location.character + 1 };
}

function makeViolation({ rule, file, sourceFile, text, position, match, source, expressionHash }) {
  const location = sourceFile ? locationOf(sourceFile, position) : offsetLocation(text, position);
  return {
    rule,
    file,
    ...location,
    match,
    source: source ?? sourceLine(text, position),
    ...(expressionHash ? { expressionHash } : {}),
    message: ruleDescriptions[rule],
  };
}

function offsetLocation(text, position) {
  const before = text.slice(0, position);
  const lines = before.split('\n');
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function nodeName(node) {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    return nodeName(node.argumentExpression);
  }
  return undefined;
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function literalContent(node, sourceFile) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, position: node.getStart(sourceFile) + 1 };
  }
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return { text: node.text, position: node.getStart(sourceFile) + 1 };
  }
  return undefined;
}

function visitLiteralFragments(node, sourceFile, callback) {
  const literal = literalContent(node, sourceFile);
  if (literal) {
    callback(literal);
    return;
  }
  node.forEachChild((child) => visitLiteralFragments(child, sourceFile, callback));
}

function scanPatternInFragment({ pattern, rule, fragment, file, sourceFile, sourceText, ignore }) {
  const violations = [];
  pattern.lastIndex = 0;
  for (const match of fragment.text.matchAll(pattern)) {
    if (ignore?.(match[0])) continue;
    violations.push(
      makeViolation({
        rule,
        file,
        sourceFile,
        text: sourceText,
        position: fragment.position + (match.index ?? 0),
        match: match[0],
      })
    );
  }
  return violations;
}

function scanClassFragment(context) {
  return [
    ...scanPatternInFragment({
      ...context,
      pattern: patterns.arbitraryProperty,
      rule: 'arbitrary-property',
      ignore: isIdiomaticRadixGeometryArbitraryValue,
    }),
    ...scanPatternInFragment({
      ...context,
      pattern: patterns.arbitraryValue,
      rule: 'arbitrary-value',
      ignore: (match) => ignoredArbitraryVariantPattern.test(match) || isIdiomaticRadixGeometryArbitraryValue(match),
    }),
    ...scanPatternInFragment({
      ...context,
      pattern: patterns.paletteColor,
      rule: 'tailwind-palette-color',
    }),
    ...scanPatternInFragment({
      ...context,
      pattern: patterns.hardcodedColor,
      rule: 'hardcoded-color',
    }),
    ...scanPatternInFragment({
      ...context,
      pattern: patterns.nonShadcnToken,
      rule: 'non-shadcn-color-token',
    }),
    ...scanPatternInFragment({
      ...context,
      pattern: patterns.legacyCssToken,
      rule: 'legacy-ui-vocabulary',
    }),
  ];
}

function isIdiomaticRadixGeometryArbitraryValue(match) {
  const openingBracket = match.indexOf('[');
  if (openingBracket === -1 || !match.endsWith(']')) return false;
  const bracketValue = match.slice(openingBracket + 1, -1);
  const propertyOrUtility = match.startsWith('[')
    ? bracketValue.slice(0, bracketValue.indexOf(':'))
    : match.slice(0, openingBracket - 1);
  const value = match.startsWith('[') ? bracketValue.slice(bracketValue.indexOf(':') + 1) : bracketValue;
  const variable = /^var\((--radix-[a-z0-9-]+)\)$/.exec(value)?.[1];
  if (!variable || !radixGeometryVariablePattern.test(variable)) return false;

  if (variable.endsWith('-transform-origin'))
    return propertyOrUtility === 'transform-origin' || propertyOrUtility === 'origin';
  if (variable.endsWith('-width')) {
    return ['width', 'min-width', 'max-width', 'w', 'min-w', 'max-w'].includes(propertyOrUtility);
  }
  return ['height', 'min-height', 'max-height', 'h', 'min-h', 'max-h'].includes(propertyOrUtility);
}

function scanPaintFragment(context) {
  return [
    ...scanPatternInFragment({
      ...context,
      pattern: patterns.hardcodedColor,
      rule: 'hardcoded-color',
    }),
    ...scanPatternInFragment({
      ...context,
      pattern: patterns.nonShadcnToken,
      rule: 'non-shadcn-color-token',
    }),
    ...scanPatternInFragment({
      ...context,
      pattern: patterns.legacyCssToken,
      rule: 'legacy-ui-vocabulary',
    }),
  ];
}

function inspectTypeScript(file, sourceText) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, kind);
  const violations = [];
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const constInitializers = new Map();
  const scopeBindings = new Map();

  const bindingNames = (name, names = []) => {
    if (ts.isIdentifier(name)) {
      names.push(name.text);
      return names;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
    }
    return names;
  };

  const lexicalScope = (node) => {
    let current = node.parent;
    while (current) {
      if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current) || ts.isCaseBlock(current)) {
        return current;
      }
      current = current.parent;
    }
    return sourceFile;
  };

  const indexBindings = (node) => {
    if (ts.isVariableDeclaration(node)) {
      const scope = lexicalScope(node);
      const bindings = scopeBindings.get(scope) ?? new Set();
      for (const name of bindingNames(node.name)) bindings.add(name);
      scopeBindings.set(scope, bindings);

      if (
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        const initializers = constInitializers.get(scope) ?? new Map();
        initializers.set(node.name.text, node.initializer);
        constInitializers.set(scope, initializers);
      }
    }
    ts.forEachChild(node, indexBindings);
  };
  indexBindings(sourceFile);

  const lookupConstInitializer = (identifier) => {
    let current = identifier.parent;
    while (current) {
      if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current) || ts.isCaseBlock(current)) {
        const initializer = constInitializers.get(current)?.get(identifier.text);
        if (initializer) return initializer;
        if (scopeBindings.get(current)?.has(identifier.text)) return undefined;
      }
      current = current.parent;
    }
    return undefined;
  };

  const resolveConstStyleExpression = (expression, seen = new Set()) => {
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped || !ts.isIdentifier(unwrapped) || seen.has(unwrapped.text)) return unwrapped;
    const initializer = lookupConstInitializer(unwrapped);
    if (!initializer) return unwrapped;
    seen.add(unwrapped.text);
    return resolveConstStyleExpression(initializer, seen);
  };

  const parameterDeclares = (parameter, name) => bindingNames(parameter.name).includes(name);
  const isParameterBinding = (identifier, name) => {
    let current = identifier.parent;
    while (current) {
      if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current) || ts.isCaseBlock(current)) {
        if (scopeBindings.get(current)?.has(name)) return false;
      }
      if (ts.isFunctionLike(current)) {
        if (current.parameters.some((parameter) => parameterDeclares(parameter, name))) return true;
      }
      current = current.parent;
    }
    return false;
  };

  const isExactStylePropForwarding = (expression) => {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      return !lookupConstInitializer(unwrapped) && isParameterBinding(unwrapped, unwrapped.text);
    }
    if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === 'style') {
      const receiver = unwrapExpression(unwrapped.expression);
      return ts.isIdentifier(receiver) && isParameterBinding(receiver, receiver.text);
    }
    if (
      ts.isElementAccessExpression(unwrapped) &&
      unwrapped.argumentExpression &&
      nodeName(unwrapped.argumentExpression) === 'style'
    ) {
      const receiver = unwrapExpression(unwrapped.expression);
      return ts.isIdentifier(receiver) && isParameterBinding(receiver, receiver.text);
    }
    return false;
  };

  const normalizedExpression = (expression) =>
    printer.printNode(ts.EmitHint.Expression, resolveConstStyleExpression(expression), sourceFile).trim();

  const normalizedStyleAttribute = (attribute) => {
    if (!attribute.initializer) return 'style';
    if (ts.isStringLiteral(attribute.initializer)) {
      return `style=${JSON.stringify(attribute.initializer.text)}`;
    }
    const expression = attribute.initializer.expression;
    return expression ? `style={${normalizedExpression(expression)}}` : 'style={}';
  };
  const scannedClassLiterals = new Set();
  const scannedPaintLiterals = new Set();

  const scanClassNode = (node) => {
    visitLiteralFragments(node, sourceFile, (fragment) => {
      const key = `${fragment.position}:${fragment.text.length}`;
      if (scannedClassLiterals.has(key)) return;
      scannedClassLiterals.add(key);
      violations.push(...scanClassFragment({ fragment, file, sourceFile, sourceText }));
    });
  };

  const scanPaintNode = (node) => {
    visitLiteralFragments(node, sourceFile, (fragment) => {
      const key = `${fragment.position}:${fragment.text.length}`;
      if (scannedPaintLiterals.has(key)) return;
      scannedPaintLiterals.add(key);
      violations.push(...scanPaintFragment({ fragment, file, sourceFile, sourceText }));
    });
  };

  const addNodeViolation = (rule, node, match = node.getText(sourceFile), details = {}) => {
    violations.push(
      makeViolation({
        rule,
        file,
        sourceFile,
        text: sourceText,
        position: node.getStart(sourceFile),
        match,
        ...details,
      })
    );
  };

  const visit = (node) => {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (
        name === 'class' ||
        name === 'classes' ||
        name === 'classNames' ||
        name === 'className' ||
        name.endsWith('ClassName')
      ) {
        if (node.initializer) scanClassNode(node.initializer);
      } else if (name === 'style') {
        const expression =
          node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
        if (!expression || !isExactStylePropForwarding(expression)) {
          const source = normalizedStyleAttribute(node);
          addNodeViolation('inline-style', node.name, 'style', {
            source,
            expressionHash: sha256(source),
          });
          if (expression) scanPaintNode(resolveConstStyleExpression(expression));
          else if (node.initializer) scanPaintNode(node.initializer);
        }
      } else if (paintPropertyNames.has(name) || /(?:color|colors|colour|colours|palette|presets)$/i.test(name)) {
        if (node.initializer) scanPaintNode(node.initializer);
      }
    }

    if (ts.isCallExpression(node) && classCallNames.has(callName(node.expression))) {
      for (const argument of node.arguments) scanClassNode(argument);
    }

    if (ts.isVariableDeclaration(node)) {
      const name = nodeName(node.name);
      const initializer = node.initializer && unwrapExpression(node.initializer);
      if (name && /styles$/i.test(name) && initializer && ts.isObjectLiteralExpression(initializer)) {
        addNodeViolation('styles-map', node.name, name);
        scanClassNode(initializer);
        scanPaintNode(initializer);
      } else if (name && /(?:class|className|classes)$/i.test(name) && node.initializer) {
        scanClassNode(node.initializer);
      } else if (name && paintVariablePattern.test(name) && node.initializer) {
        scanPaintNode(node.initializer);
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const name = nodeName(node.name);
      if (name && paintPropertyNames.has(name)) {
        scanPaintNode(node.initializer);
      } else if (name && /(?:class|className|classes)$/i.test(name)) {
        scanClassNode(node.initializer);
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      const isStyleCssTextAssignment =
        ts.isPropertyAccessExpression(left) &&
        left.name.text === 'cssText' &&
        ((ts.isPropertyAccessExpression(left.expression) && left.expression.name.text === 'style') ||
          (ts.isElementAccessExpression(left.expression) && propertyName(left.expression) === 'style'));
      if (
        isStyleCssTextAssignment ||
        ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
          paintPropertyNames.has(propertyName(left)) &&
          ((ts.isPropertyAccessExpression(left.expression) && left.expression.name.text === 'style') ||
            (ts.isElementAccessExpression(left.expression) && propertyName(left.expression) === 'style')))
      ) {
        addNodeViolation('dom-style-mutation', left, left.getText(sourceFile));
        scanPaintNode(node.right);
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setProperty' &&
      ((ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === 'style') ||
        (ts.isElementAccessExpression(node.expression.expression) &&
          propertyName(node.expression.expression) === 'style'))
    ) {
      const property = node.arguments[0];
      const name = property && (ts.isStringLiteralLike(property) ? property.text : undefined);
      addNodeViolation(
        'dom-style-mutation',
        node.expression,
        name ? `style.setProperty(${JSON.stringify(name)})` : 'style.setProperty'
      );
      for (const argument of node.arguments) scanPaintNode(argument);
    }

    if (ts.isIdentifier(node)) {
      if (node.text === 'SegmentedControl') addNodeViolation('compatibility-component', node, node.text);
      if (node.text === 'makeStyles' || /griffel/i.test(node.text)) {
        addNodeViolation('legacy-ui-vocabulary', node, node.text);
      }
    }

    if (ts.isStringLiteralLike(node)) {
      const text = node.text;
      if (/griffel/i.test(text) || /@fluentui\//i.test(text)) {
        addNodeViolation('legacy-ui-vocabulary', node, text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return deduplicateViolations(violations);
}

function maskCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function inspectCss(file, sourceText) {
  const text = maskCssComments(sourceText);
  const violations = [];

  const yooptaSelectorPattern = /\.yoopta-ui-[\w-]+|\[\s*class\*=\s*(['"])yoopta-ui-[^'"]*\1\s*\]/g;
  for (const selector of text.matchAll(yooptaSelectorPattern)) {
    violations.push(
      makeViolation({
        rule: 'third-party-theme-override',
        file,
        text: sourceText,
        position: selector.index ?? 0,
        match: selector[0],
      })
    );
  }

  const declarationPattern = /(?:^|[;{])\s*(--[\w-]+|[a-zA-Z][\w-]*)\s*:\s*([^;{}]+)/gm;
  for (const declaration of text.matchAll(declarationPattern)) {
    const property = declaration[1];
    const value = declaration[2];
    const propertyPosition = (declaration.index ?? 0) + declaration[0].indexOf(property);
    const valuePosition = (declaration.index ?? 0) + declaration[0].indexOf(value);
    const isPaint = property.startsWith('--') || paintCssPropertyPattern.test(property);
    const isApprovedThemeDefinition =
      file === 'src/renderer/styles/tailwind.css' && approvedThemePaintTokens.has(property);
    if (isPaint && !isApprovedThemeDefinition) {
      violations.push(
        ...scanPaintFragment({
          fragment: { text: value, position: valuePosition },
          file,
          sourceText,
        })
      );
    }
    for (const [pattern, rule] of [
      [patterns.nonShadcnToken, 'non-shadcn-color-token'],
      [patterns.legacyCssToken, 'legacy-ui-vocabulary'],
    ]) {
      violations.push(
        ...scanPatternInFragment({
          pattern,
          rule,
          fragment: { text: property, position: propertyPosition },
          file,
          sourceText,
        })
      );
    }
  }

  const applyPattern = /@apply\s+([^;{}]+);/g;
  for (const apply of text.matchAll(applyPattern)) {
    const value = apply[1];
    const valuePosition = (apply.index ?? 0) + apply[0].indexOf(value);
    violations.push(
      ...scanClassFragment({
        fragment: { text: value, position: valuePosition },
        file,
        sourceText,
      })
    );
  }

  return deduplicateViolations(violations);
}

function deduplicateViolations(violations) {
  const seen = new Set();
  return violations.filter((violation) => {
    const key = `${violation.rule}:${violation.file}:${violation.line}:${violation.column}:${violation.match}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reconcileApprovals(violations, approvals) {
  const approvalMatches = new Set();
  const activeViolations = violations.filter((violation) => {
    const approvalIndex = approvals.findIndex(
      (approval) =>
        approval.rule === violation.rule &&
        approval.file === violation.file &&
        approval.match === violation.match &&
        approval.source === violation.source &&
        approval.expressionHash === violation.expressionHash
    );
    if (approvalIndex === -1) return true;
    approvalMatches.add(approvalIndex);
    return false;
  });

  for (const [index, approval] of approvals.entries()) {
    const invalidExpressionHash =
      approval.rule === 'inline-style' && !/^[a-f0-9]{64}$/.test(approval.expressionHash ?? '');
    if (
      !approval.reason?.trim() ||
      typeof approval.source !== 'string' ||
      !approval.source.trim() ||
      invalidExpressionHash
    ) {
      activeViolations.push({
        rule: 'invalid-approval',
        file: approval.file,
        line: 1,
        column: 1,
        match: approval.match,
        source: approval.source ?? '',
        message:
          'Every approved violation requires exact normalized source, a user-approved reason, and inline styles require their expression hash.',
      });
    } else if (!approvalMatches.has(index)) {
      activeViolations.push({
        rule: 'stale-approval',
        file: approval.file,
        line: 1,
        column: 1,
        match: approval.match,
        source: approval.source ?? '',
        message: 'This approved violation no longer matches source and must be removed or reviewed again.',
      });
    }
  }

  return activeViolations;
}

function runSelfTest() {
  const tsxFixture = `
const issue = 'Follow up on GitHub issue #295 and document w-[37px] [display:flex].';
const normalCopy = 'The color-mix() documentation is informational.';
const styles = { root: '[display:flex] [color:var(--foreground)] w-[37px] text-red-500' };
const iconColor = '#abcdef';
const className = cn('bg-[#123456]', condition && '[color:var(--info)]', 'text-[var(--colorNeutral)]');
element.style.backgroundColor = 'rgb(1 2 3)';
element.style.cssText = 'background: #123456';
element.style.setProperty('border-color', 'hsl(1 2% 3%)');
element.style.setProperty('--app-height', '10px');
const compatibility = SegmentedControl;
const fluent = makeStyles;
export const Example = () => (
  <div contentClassName="border-blue-500" style={{ color: '#ff0000' }}>
    <svg><stop stopColor="#654321" /></svg>
  </div>
);
`;
  const tsxViolations = inspectTypeScript('src/renderer/example.tsx', tsxFixture);
  const found = new Set(tsxViolations.map((violation) => violation.rule));
  for (const expected of [
    'arbitrary-property',
    'arbitrary-value',
    'inline-style',
    'dom-style-mutation',
    'styles-map',
    'hardcoded-color',
    'tailwind-palette-color',
    'non-shadcn-color-token',
    'legacy-ui-vocabulary',
    'compatibility-component',
  ]) {
    assert(found.has(expected), `self-test did not detect ${expected}`);
  }
  assert(!tsxViolations.some((violation) => violation.match === '#295'), 'issue number was treated as paint');
  assert(tsxViolations.some((violation) => violation.match === '#abcdef'));
  assert(tsxViolations.some((violation) => violation.match === '#654321'));
  assert(
    tsxViolations.some((violation) => violation.match.includes('--app-height')),
    'custom geometry mutation escaped explicit review'
  );
  assert(
    tsxViolations.some((violation) => violation.match.includes('style.cssText')),
    'cssText mutation escaped explicit review'
  );
  assert(
    !tsxViolations.some((violation) => violation.source.includes('normalCopy')),
    'ordinary prose was treated as styling'
  );

  assert(shouldScanBoundaryFile('src/renderer/features/example.tsx'));
  assert(!shouldScanBoundaryFile('src/renderer/ds/ui/button.tsx'));

  const radixFixture = `
const className = cn(
  'w-[var(--radix-popover-trigger-width)]',
  'max-h-[var(--radix-select-content-available-height)]',
  '[transform-origin:var(--radix-dropdown-menu-content-transform-origin)]',
  'w-[var(--ordinary-width)]',
  'w-[calc(var(--radix-popover-trigger-width)+1px)]',
  '[color:var(--radix-popover-trigger-width)]'
);
`;
  const radixViolations = inspectTypeScript('src/renderer/radix.tsx', radixFixture);
  assert.equal(
    radixViolations.filter((violation) => violation.rule === 'arbitrary-value').length,
    2,
    'Radix geometry exception was broader or narrower than the exact known variable form'
  );
  assert.equal(
    radixViolations.filter((violation) => violation.rule === 'arbitrary-property').length,
    1,
    'Radix geometry variables were accepted for a non-geometry paint property'
  );

  const resolvedStyleFixture = `
export const Example = () => {
  const baseStyle = { color: '#ff0000' };
  const style = baseStyle;
  return <div style={style} />;
};
`;
  const resolvedStyleViolations = inspectTypeScript('src/renderer/resolved.tsx', resolvedStyleFixture);
  const resolvedInlineStyle = resolvedStyleViolations.find((violation) => violation.rule === 'inline-style');
  assert(resolvedInlineStyle, 'same-scope const style escaped inline-style review');
  assert.equal(resolvedInlineStyle.source, "style={{ color: '#ff0000' }}");
  assert.match(resolvedInlineStyle.expressionHash, /^[a-f0-9]{64}$/);
  assert(
    resolvedStyleViolations.some((violation) => violation.match === '#ff0000'),
    'paint in a resolved const style escaped review'
  );

  const equivalentFormattingFixture = `
export const Example=()=>{const baseStyle={color:'#ff0000'};const style=baseStyle;return <div style = { style }/>}
`;
  const equivalentInlineStyle = inspectTypeScript('src/renderer/resolved.tsx', equivalentFormattingFixture).find(
    (violation) => violation.rule === 'inline-style'
  );
  assert.equal(
    equivalentInlineStyle.expressionHash,
    resolvedInlineStyle.expressionHash,
    'formatting changed the stable inline-style expression fingerprint'
  );

  const changedStyleFixture = resolvedStyleFixture.replace(
    "{ color: '#ff0000' }",
    "{ color: '#ff0000', backgroundColor: '#000000' }"
  );
  const changedInlineStyle = inspectTypeScript('src/renderer/resolved.tsx', changedStyleFixture).find(
    (violation) => violation.rule === 'inline-style'
  );
  assert.notEqual(
    changedInlineStyle.expressionHash,
    resolvedInlineStyle.expressionHash,
    'adding paint did not invalidate the inline-style fingerprint'
  );

  const forwardingFixture = `
export function Direct({ style, preStyle }) {
  return <><div style={style} /><pre style={preStyle} /></>;
}
export const Member = (props) => <div style={props.style} />;
export const Element = (props) => <div style={props['style']} />;
`;
  assert.equal(
    inspectTypeScript('src/renderer/forwarding.tsx', forwardingFixture).filter(
      (violation) => violation.rule === 'inline-style'
    ).length,
    0,
    'exact, unmodified style-prop forwarding was treated as a local inline style'
  );

  const approval = {
    rule: resolvedInlineStyle.rule,
    file: resolvedInlineStyle.file,
    match: resolvedInlineStyle.match,
    source: resolvedInlineStyle.source,
    expressionHash: resolvedInlineStyle.expressionHash,
    reason: 'User-approved fixture.',
  };
  assert.equal(reconcileApprovals([resolvedInlineStyle], [approval]).length, 0);
  const staleApprovalResults = reconcileApprovals([changedInlineStyle], [approval]);
  assert(staleApprovalResults.some((violation) => violation.rule === 'inline-style'));
  assert(staleApprovalResults.some((violation) => violation.rule === 'stale-approval'));
  assert(
    reconcileApprovals([resolvedInlineStyle], [{ ...approval, expressionHash: undefined }]).some(
      (violation) => violation.rule === 'invalid-approval'
    ),
    'inline-style approval without an expression hash was accepted'
  );

  const cssFixture = `
/* .ignored { color: #deadbe; --warning: red; } */
.bad { color: #123456; background: color-mix(in oklch, red, blue); }
.fixed { @apply text-rose-500 w-[37px] [display:grid]; color: var(--info); }
.token { --info: #badbad; }
.copy::after { content: "#295 --info"; }
.yoopta-ui-slash-command-content { padding: 1rem; }
[class*='yoopta-ui-floating-toolbar'] { border: 0; }
.allowed { --yoopta-ui-background: 0 0% 100%; }
`;
  const cssViolations = inspectCss('src/renderer/example.css', cssFixture);
  assert(cssViolations.some((violation) => violation.rule === 'hardcoded-color'));
  assert(cssViolations.some((violation) => violation.rule === 'tailwind-palette-color'));
  assert(cssViolations.some((violation) => violation.rule === 'arbitrary-property'));
  assert(cssViolations.some((violation) => violation.rule === 'arbitrary-value'));
  assert(cssViolations.some((violation) => violation.rule === 'non-shadcn-color-token'));
  assert.equal(
    cssViolations.filter((violation) => violation.rule === 'third-party-theme-override').length,
    2,
    'Yoopta class-selector overrides were not detected exactly'
  );
  assert(!cssViolations.some((violation) => violation.match === '#deadbe'));
  assert(!cssViolations.some((violation) => violation.match === '#295'));
  assert(
    !cssViolations.some(
      (violation) => violation.source.includes('.copy::after') && violation.rule === 'non-shadcn-color-token'
    )
  );

  const themeFixture = ':root { --background: oklch(1 0 0); }';
  assert.equal(inspectCss('src/renderer/styles/tailwind.css', themeFixture).length, 0);
  console.log('shadcn boundary linter self-test passed');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

await collect(rendererRoot);

const violations = [];
for (const absolute of files.sort()) {
  const relative = path.relative(process.cwd(), absolute);
  if (!shouldScanBoundaryFile(relative) || excludedFiles.has(relative)) continue;

  const text = await readFile(absolute, 'utf8');
  violations.push(...(relative.endsWith('.css') ? inspectCss(relative, text) : inspectTypeScript(relative, text)));
}

const infrastructureViolations = [];
const checkInfrastructure = async () => {
  const addInfrastructureViolation = (rule, file, match, message) => {
    infrastructureViolations.push({
      rule,
      file,
      line: 1,
      column: 1,
      match,
      source: '',
      message,
    });
  };

  const themeCss = await readFile(path.join(rendererRoot, 'styles/tailwind.css'), 'utf8');
  if (/\*:focus-visible\s*\{/.test(maskCssComments(themeCss))) {
    addInfrastructureViolation(
      'global-component-override',
      'src/renderer/styles/tailwind.css',
      '*:focus-visible',
      'Global focus styling overrides stock shadcn component focus states.'
    );
  }
  for (let index = 1; index <= 5; index += 1) {
    const marker = `--color-chart-${index}: var(--chart-${index});`;
    if (!themeCss.includes(marker)) {
      addInfrastructureViolation(
        'theme-mapping',
        'src/renderer/styles/tailwind.css',
        marker,
        `Missing stock chart mapping: ${marker}`
      );
    }
  }
};

await checkInfrastructure();
violations.push(...infrastructureViolations);

const activeViolations = reconcileApprovals(violations, approvedViolations);

const counts = Object.fromEntries(
  [...new Set(activeViolations.map((violation) => violation.rule))]
    .sort()
    .map((rule) => [rule, activeViolations.filter((violation) => violation.rule === rule).length])
);

if (reportMode === 'json') {
  console.log(
    JSON.stringify(
      {
        violations: activeViolations,
        counts,
        approvedViolations,
        excludedFiles: exceptionConfig.excludedFiles,
      },
      null,
      2
    )
  );
} else {
  console.error(`shadcn boundary lint found ${activeViolations.length} violation(s) outside the deferred sidebar.`);
  for (const [rule, count] of Object.entries(counts)) console.error(`  ${rule}: ${count}`);
  console.error(`  deferred sidebar files: ${excludedFiles.size}`);
  console.error(`  explicitly approved violations: ${approvedViolations.length}`);

  if (reportMode === 'full' && activeViolations.length > 0) {
    console.error('');
    for (const violation of activeViolations) {
      console.error(`${violation.file}:${violation.line}:${violation.column}  ${violation.rule}  ${violation.match}`);
      if (violation.source) console.error(`  ${violation.source}`);
    }
  }
}

if (activeViolations.length > 0) {
  process.exitCode = 1;
} else {
  console.log('shadcn boundaries OK: no violations outside the deferred sidebar');
}
