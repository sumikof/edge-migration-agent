import type { JsonSchema } from './schema.js';

const str: JsonSchema = { type: 'string' };
const bool: JsonSchema = { type: 'boolean' };
const strList: JsonSchema = { type: 'array', items: { type: 'string' } };
const patternRule: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'regex'],
  properties: { name: str, regex: { type: 'string', minLength: 1 }, flags: str, replacement: str },
};

export const STEP_OPS = [
  // Original starter operations (kept unchanged).
  'navigate', 'waitVisible', 'click', 'fill', 'select', 'assertTextContains', 'captureText', 'screenshot',
  // Extensions.
  'waitHidden', 'waitText', 'waitUrl', 'wait', 'check', 'uncheck', 'press',
  'assertTextEquals', 'assertValue', 'assertChecked', 'assertUrlContains', 'assertVisible', 'assertNotVisible',
  'captureValue', 'captureAttribute', 'captureDom', 'captureFormState', 'captureUrl',
  'switchWindow', 'closeWindow', 'dialog',
] as const;

export const stepSchema: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['op'],
  properties: {
    op: { type: 'string', enum: [...STEP_OPS] },
    path: str,
    selector: str,
    xpath: str,
    frame: { type: ['string', 'array'], items: str, description: 'CSS (or "xpath=...") of an iframe, or a list for nested iframes, outermost first.' },
    value: str,
    label: str,
    index: { type: 'integer', minimum: 0 },
    text: str,
    key: str,
    name: str,
    attribute: str,
    optional: bool,
    secret: { type: 'boolean', description: 'Never store or print the value of this step.' },
    category: { type: 'string', enum: ['business', 'validation', 'display'] },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
    retries: { type: 'integer', minimum: 0, maximum: 5 },
    ms: { type: 'integer', minimum: 0, maximum: 10000 },
    action: { type: 'string', enum: ['accept', 'dismiss'] },
    promptText: str,
    titleContains: str,
    urlContains: str,
    mask: strList,
    note: str,
  },
};

export const scenarioSchema: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'steps'],
  properties: {
    name: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' },
    description: str,
    tags: strList,
    allowMutatingRequests: { type: 'boolean', description: 'Edge only: let POST/PUT/PATCH/DELETE through when safety.blockMutatingRequests is on. Use only against disposable test data.' },
    steps: { type: 'array', items: stepSchema },
  },
};

export const configSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['ieBaseUrl', 'edgeBaseUrl', 'viewport', 'timeoutMs', 'visualDiffThreshold', 'maxDiffRatio'],
  properties: {
    $comment: str,
    ieBaseUrl: { type: 'string', pattern: '^https?://' },
    edgeBaseUrl: { type: 'string', pattern: '^https?://' },
    edgeExecutablePath: str,
    viewport: {
      type: 'object', additionalProperties: false, required: ['width', 'height'],
      properties: { width: { type: 'integer', minimum: 200, maximum: 7680 }, height: { type: 'integer', minimum: 200, maximum: 4320 } },
    },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 },
    visualDiffThreshold: { type: 'number', minimum: 0, maximum: 1 },
    maxDiffRatio: { type: 'number', minimum: 0, maximum: 1 },
    retries: {
      type: 'object', additionalProperties: false,
      properties: { step: { type: 'integer', minimum: 0, maximum: 5 }, launch: { type: 'integer', minimum: 0, maximum: 5 } },
    },
    ie: {
      type: 'object', additionalProperties: false,
      properties: {
        expectedDocumentMode: { type: ['integer', 'null'], minimum: 5, maximum: 11 },
        ensureCleanSession: bool,
        ignoreZoomSetting: bool,
        attachTimeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
      },
    },
    edge: {
      type: 'object', additionalProperties: false,
      properties: {
        channel: str,
        headless: bool,
        requireEdgeBrand: bool,
      },
    },
    compare: {
      type: 'object', additionalProperties: false,
      properties: {
        visualGate: { type: 'boolean', description: 'When true, visual differences fail the comparison. Default false: images are auxiliary evidence.' },
        failOnPageErrors: bool,
        failOnHttpErrors: bool,
        ignoreCaptureKeys: strList,
        domIgnoreAttributes: strList,
      },
    },
    masking: {
      type: 'object', additionalProperties: false,
      properties: {
        redactPII: bool,
        redact: { type: 'array', items: patternRule },
        normalizeDynamic: bool,
        normalize: { type: 'array', items: patternRule },
      },
    },
    safety: {
      type: 'object', additionalProperties: false,
      properties: {
        blockMutatingRequests: bool,
        productionUrlPatterns: strList,
      },
    },
  },
};

export const migrationSchema: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['targetApp', 'fix'],
  properties: {
    $comment: str,
    targetApp: {
      type: 'object', additionalProperties: false, required: ['sourceRoot'],
      properties: {
        sourceRoot: { type: 'string', description: 'Absolute path of the external business application source. Empty disables analysis and fixes.' },
        include: strList,
        exclude: strList,
        defaultEncoding: { type: 'string', enum: ['auto', 'utf-8', 'shift_jis', 'cp932', 'euc-jp'] },
        encodingOverrides: { type: 'object', additionalProperties: { type: 'string', enum: ['utf-8', 'shift_jis', 'cp932', 'euc-jp'] } },
        maxFileBytes: { type: 'integer', minimum: 1024, maximum: 50 * 1024 * 1024 },
      },
    },
    fix: {
      type: 'object', additionalProperties: false,
      properties: {
        allowWrite: { type: 'boolean', description: 'Must be true before any fix command modifies the external source.' },
        writableGlobs: strList,
        maxAttemptsPerFinding: { type: 'integer', minimum: 1, maximum: 10 },
        maxTotalAttempts: { type: 'integer', minimum: 1, maximum: 100 },
        maxEditsPerAttempt: { type: 'integer', minimum: 1, maximum: 50 },
        requireGit: bool,
        requireCleanFiles: bool,
        verifyScenarios: strList,
      },
    },
  },
};
