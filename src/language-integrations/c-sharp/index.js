import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {DOTNET_SOURCE_POLICY} from '../source-policies.js';
import {dotnetDependency} from './dependency.js';

export const integration = {
    id: 'c-sharp',
    name: 'C#',
    grammar: 'c_sharp',
    family: 'dotnet',
    aliases: ['csharp', 'c#', 'cs'],
    extensions: ['.cs'],
    filenames: [],
    source: DOTNET_SOURCE_POLICY,
    dependency: dotnetDependency,
    repo: {
        sourceRoles: ['application source', 'service class', 'controller', 'domain model'],
        supportingFiles: [
            {glob: '**/*.csproj', role: 'manifest', terms: ['project', 'target framework', 'package reference']},
            {glob: '**/*.sln', role: 'manifest', terms: ['solution', 'project']},
            {glob: '**/Directory.Build.props', role: 'configuration', terms: ['build', 'properties']},
            {glob: '**/NuGet.config', role: 'configuration', terms: ['package source', 'nuget']}
        ],
        questionTerms: ['c#', 'csharp', 'dotnet', 'controller', 'service', 'namespace'],
        evidenceTerms: ['class', 'method', 'using', 'project', 'package reference']
    },
    queries: {
        definitions: [
            {
                id: 'class-declaration',
                query: '(class_declaration name: (identifier) @name) @definition',
                detail: 'declares a C# class'
            },
            {
                id: 'method-declaration',
                query: '(method_declaration name: (identifier) @name) @definition',
                detail: 'declares a C# method'
            }
        ],
        imports: [
            {
                id: 'using-directive',
                query: '(using_directive (identifier) @target) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a C# namespace'
            }
        ],
        calls: [
            {
                id: 'invocation-expression',
                query: '(invocation_expression function: (identifier) @name) @call',
                detail: 'calls a C# function'
            },
            {
                id: 'member-invocation-expression',
                query: '(invocation_expression function: (member_access_expression name: (identifier) @name)) @call',
                detail: 'calls a C# member'
            }
        ]
    },
    contract: {
        path: 'src/Handler.cs',
        source: [
            'using System;',
            '[ApiController]',
            'public class CheckoutService {',
            '    public int Checkout() {',
            '        var token = Environment.GetEnvironmentVariable("API_TOKEN");',
            '        Console.WriteLine("ok");',
            '        return 1;',
            '    }',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'import', target: 'System'},
            {kind: 'definition', name: 'CheckoutService'},
            {kind: 'definition', name: 'Checkout'},
            {kind: 'call', name: 'WriteLine'}
        ],
        expectedLineFacts: [
            {kind: 'component', name: 'ApiController'},
            {kind: 'configuration', name: 'API_TOKEN'}
        ],
        callLine: 'service.Checkout();',
        excludedPaths: ['tests/HandlerTest.cs', 'bin/Handler.cs', 'obj/Handler.cs'],
        dependencyManifestPaths: ['src/App.csproj', 'Directory.Packages.props'],
        dependencyFixtures: [
            {
                path: 'src/App.csproj',
                content: [
                    '<Project Sdk="Microsoft.NET.Sdk.Web">',
                    '  <ItemGroup>',
                    '    <PackageReference Include="Dapper" Version="2.1.35" />',
                    '  </ItemGroup>',
                    '</Project>'
                ].join('\n'),
                expectedDocs: [
                    {path: '__dependencies__/nuget/Dapper.md', includes: ['Dapper 2.1.35', 'PackageReference']}
                ]
            }
        ]
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'route',
            pattern: /\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|Route)\s*(?:\(\s*"([^"]+)")?/g,
            name: (match) => `${dotnetHttpMethod(match[1])}${match[2] ? ` ${match[2]}` : ''}`,
            target: 2,
            detail: 'declares an ASP.NET route'
        }),
        patternFactExtractor({
            kind: 'route',
            pattern: /\bapp\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/g,
            name: (match) => `${match[1].toUpperCase()} ${match[2]}`,
            target: 2,
            detail: 'maps an ASP.NET minimal API route'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\bEnvironment\.GetEnvironmentVariable\(\s*"([^"]+)"/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\b(?:configuration|config)\s*\[\s*"([^"]+)"\s*]/gi,
            name: 1,
            target: 1,
            detail: 'reads ASP.NET configuration'
        }),
        patternFactExtractor({
            kind: 'storage',
            pattern: /\b([A-Za-z_][A-Za-z0-9_.]*)\.(SaveChanges|Find|FindAsync|Add|AddAsync|Update|Remove|ExecuteSqlRaw|Query|QueryAsync)\s*\(/g,
            name: (match) => `${match[1]}.${match[2]}`,
            target: 2,
            detail: 'uses a storage or database boundary'
        }),
        patternFactExtractor({
            kind: 'component',
            pattern: /^\[(ApiController|Controller|ServiceFilter|Authorize)\b/g,
            name: 1,
            target: 1,
            detail: 'declares an ASP.NET component or policy boundary'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /\bstatic\s+(?:async\s+)?(?:Task|void|int)\s+Main\s*\(/g,
            name: 'Main',
            target: 'Main',
            detail: 'marks a C# executable entrypoint'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'C#',
        definitionPatterns: [
            {kind: 'namespace', re: /^namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\b/},
            {kind: 'class', re: /^(?:public|private|protected|internal|abstract|sealed|static|partial|\s)*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'interface', re: /^(?:public|private|protected|internal|partial|\s)*interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'record', re: /^(?:public|private|protected|internal|sealed|partial|\s)*record\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'struct', re: /^(?:public|private|protected|internal|readonly|partial|\s)*struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'enum', re: /^(?:public|private|protected|internal|\s)*enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'method', re: /^(?:public|private|protected|internal|static|async|virtual|override|sealed|abstract|partial|\s)*(?:[A-Za-z_][A-Za-z0-9_<>, ?.[\]]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/}
        ],
        bindingPatterns: [
            /^(?:var|const|readonly|[A-Za-z_][A-Za-z0-9_<>, ?.[\]]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/
        ],
        callKeywords: ['if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'throw', 'new']
    })
};

function dotnetHttpMethod(attribute) {
    const method = String(attribute || '').replace(/^Http/u, '').toUpperCase();
    return method === 'ROUTE' ? 'ROUTE' : method;
}
