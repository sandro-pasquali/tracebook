import {patternFactExtractor} from '../common.js';
import {PYTHON_SOURCE_POLICY} from '../source-policies.js';
import {pythonAnnotation} from './annotation.js';
import {pythonDependency} from './dependency.js';

export const integration = {
    id: 'python',
    name: 'Python',
    grammar: 'python',
    family: 'python',
    aliases: ['python', 'py'],
    extensions: ['.py'],
    filenames: [],
    source: PYTHON_SOURCE_POLICY,
    dependency: pythonDependency,
    repo: {
        sourceRoles: ['application module', 'service module', 'library module', 'script'],
        supportingFiles: [
            {glob: '**/setup.cfg', role: 'configuration', terms: ['packaging', 'tool config', 'python']},
            {glob: '**/tox.ini', role: 'configuration', terms: ['tox', 'environment', 'test matrix']},
            {glob: '**/pytest.ini', role: 'configuration', terms: ['pytest', 'tests', 'configuration']},
            {glob: '**/.python-version', role: 'configuration', terms: ['python version', 'runtime']}
        ],
        questionTerms: ['python', 'module', 'class', 'function', 'script', 'package', 'environment'],
        evidenceTerms: ['function', 'class', 'import', 'decorator', 'environment variable']
    },
    annotation: pythonAnnotation,
    queries: {
        definitions: [
            {
                id: 'function-definition',
                query: '(function_definition name: (identifier) @name) @definition',
                detail: 'declares a Python function'
            },
            {
                id: 'class-definition',
                query: '(class_definition name: (identifier) @name) @definition',
                detail: 'declares a Python class'
            }
        ],
        imports: [
            {
                id: 'import-statement',
                query: '(import_statement name: (dotted_name) @target) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a Python module'
            }
        ],
        calls: [
            {
                id: 'call',
                query: '(call function: (identifier) @name) @call',
                detail: 'calls a Python function'
            },
            {
                id: 'attribute-call',
                query: '(call function: (attribute attribute: (identifier) @name)) @call',
                detail: 'calls a Python method'
            }
        ]
    },
    contract: {
        path: 'src/worker.py',
        source: [
            'import os',
            'from pydantic import BaseModel',
            'class OrderModel(BaseModel):',
            '    id: int',
            '@app.get("/orders")',
            'def checkout(order):',
            '    token = os.environ.get("API_TOKEN")',
            '    save(order)',
            '    return order'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'checkout'},
            {kind: 'import', target: 'os'},
            {kind: 'call', name: 'save'}
        ],
        expectedLineFacts: [
            {kind: 'route', name: 'GET /orders'},
            {kind: 'configuration', name: 'API_TOKEN'},
            {kind: 'schema', name: 'OrderModel'}
        ],
        expectedAnnotation: {
            role: 'call boundary',
            facts: ['calls: save'],
            scoreAtLeast: 30
        },
        callLine: 'save(order)',
        excludedPaths: ['tests/worker_test.py', '.venv/lib/python3.12/site-packages/pkg.py', 'src/__pycache__/worker.py'],
        dependencyManifestPaths: ['pyproject.toml', 'requirements.txt']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'route',
            pattern: /^@(?:[A-Za-z_][A-Za-z0-9_]*\.)?(get|post|put|patch|delete|route)\(\s*['"`]([^'"`]+)['"`]/gi,
            name: (match) => `${match[1].toUpperCase()} ${match[2]}`,
            target: 2,
            detail: 'declares a Python web route'
        }),
        patternFactExtractor({
            kind: 'route',
            pattern: /\b(?:app|router|api)\.add_api_route\(\s*['"`]([^'"`]+)['"`]/gi,
            name: (match) => `ROUTE ${match[1]}`,
            target: 1,
            detail: 'registers a Python API route'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\bos\.environ(?:\.get)?\(\s*['"]([^'"]+)['"]/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'schema',
            pattern: /^class\s+([A-Za-z_][A-Za-z0-9_]*)\((?:[^)]*\.)?(BaseModel|dataclass)\)\s*:/g,
            name: 1,
            target: 2,
            detail: 'declares a Python data schema'
        }),
        patternFactExtractor({
            kind: 'storage',
            pattern: /\b([A-Za-z_][A-Za-z0-9_.]*)\.(execute|executemany|query|filter|filter_by|get|save|add|commit|insert|update|delete|select)\s*\(/g,
            name: (match) => `${match[1]}.${match[2]}`,
            target: 2,
            detail: 'uses a storage or database boundary'
        }),
        patternFactExtractor({
            kind: 'background_task',
            pattern: /^@(?:[A-Za-z_][A-Za-z0-9_]*\.)?(task|shared_task)\b/g,
            name: 1,
            target: 1,
            detail: 'declares a Python background task'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /^@(?:click|typer)\.(command|group)\b/g,
            name: 1,
            target: 1,
            detail: 'declares a Python CLI entrypoint'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/g,
            name: 'python main guard',
            target: 'python main guard',
            detail: 'marks a Python executable entrypoint'
        })
    ]
};
