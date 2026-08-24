export function renderAgentPrompt(brief, options = {}) {
    const format = options.outputFormat ?? brief?.outputFormat ?? 'llm_prompt';
    if(format === 'repository_issue') {
        return renderRepositoryIssue(brief);
    }
    if(format === 'ticket') {
        return renderTicket(brief);
    }
    return renderLlmPrompt(brief);
}

function renderLlmPrompt(brief) {
    const lines = [];
    lines.push('You are working in this repository.');
    lines.push('');
    lines.push(`Task: ${brief.title}`);
    lines.push('');
    lines.push('Product goal:');
    lines.push(brief.productGoal);
    lines.push('');
    lines.push('Current source-grounded behavior:');
    lines.push(brief.currentBehavior);
    lines.push('');
    lines.push('Relevant files to inspect first:');
    for(const file of brief.likelyFiles || []) {
        lines.push(formatFileLine(file));
    }
    appendEvidenceBackedSection(lines, 'Existing patterns to follow:', brief.existingPatterns);
    appendEvidenceBackedSection(lines, 'Implementation constraints:', brief.implementationConstraints);
    appendStringList(lines, 'Acceptance criteria:', brief.acceptanceCriteria);
    appendEvidenceBackedSection(lines, 'Test plan:', brief.testPlan);
    appendEvidenceBackedSection(lines, 'Risk notes:', brief.riskNotes);
    appendStringList(lines, 'Open questions:', brief.openQuestions);

    lines.push('');
    lines.push('Before editing:');
    lines.push('1. Inspect the relevant files above.');
    lines.push('2. Confirm whether the existing behavior and constraints still match the current source.');
    lines.push('3. If an open question blocks a safe implementation, ask it before changing code.');
    lines.push('');
    lines.push('Output:');
    lines.push('- Briefly explain the implementation approach.');
    lines.push('- Make the code changes.');
    lines.push('- Add or update relevant tests.');
    lines.push('- Summarize changed files, tests run, assumptions, and residual risks.');
    return lines.join('\n');
}

function renderRepositoryIssue(brief) {
    const lines = [];
    lines.push(`# ${brief.title}`);
    lines.push('');
    lines.push('## Product Goal');
    lines.push('');
    lines.push(brief.productGoal);
    lines.push('');
    lines.push('## Current Behavior');
    lines.push('');
    lines.push(brief.currentBehavior);
    lines.push('');
    lines.push('## Relevant Files');
    lines.push('');
    for(const file of brief.likelyFiles || []) {
        lines.push(`- \`${file.path}\` — ${file.reason} (${file.confidence} confidence)`);
    }
    appendStringList(lines, '## Acceptance Criteria', brief.acceptanceCriteria);
    appendEvidenceBackedSection(lines, '## Technical Notes', [
        ...(brief.existingPatterns || []),
        ...(brief.implementationConstraints || [])
    ]);
    appendEvidenceBackedSection(lines, '## Test Plan', brief.testPlan);
    appendEvidenceBackedSection(lines, '## Risks', brief.riskNotes);
    appendStringList(lines, '## Open Questions', brief.openQuestions);
    return lines.join('\n');
}

function renderTicket(brief) {
    const lines = [];
    lines.push(`Title: ${brief.title}`);
    lines.push('Type: Change request');
    lines.push('');
    lines.push('Goal');
    lines.push(brief.productGoal);
    lines.push('');
    lines.push('Current behavior');
    lines.push(brief.currentBehavior);
    lines.push('');
    lines.push('Likely implementation areas');
    for(const file of brief.likelyFiles || []) {
        lines.push(formatFileLine(file));
    }
    appendEvidenceBackedSection(lines, 'Existing patterns', brief.existingPatterns);
    appendEvidenceBackedSection(lines, 'Implementation constraints', brief.implementationConstraints);
    appendStringList(lines, 'Acceptance criteria', brief.acceptanceCriteria);
    appendEvidenceBackedSection(lines, 'Test plan', brief.testPlan);
    appendEvidenceBackedSection(lines, 'Risks', brief.riskNotes);
    appendStringList(lines, 'Open questions', brief.openQuestions);
    return lines.join('\n');
}

function appendEvidenceBackedSection(lines, heading, items = []) {
    if(!Array.isArray(items) || items.length === 0) {
        return;
    }
    lines.push('');
    lines.push(heading);
    for(const item of items) {
        lines.push(`- ${item.text}${formatRefs(item.sourceRefs)}`);
    }
}

function formatFileLine(file) {
    const details = [
        file?.role && file.role !== 'source' ? file.role : '',
        file?.confidence ? `${file.confidence} confidence` : ''
    ].filter(Boolean).join(', ');
    const suffix = details ? ` (${details})` : '';
    return `- ${file.path}${suffix}: ${file.reason}`;
}

function appendStringList(lines, heading, items = []) {
    if(!Array.isArray(items) || items.length === 0) {
        return;
    }
    lines.push('');
    lines.push(heading);
    for(const item of items) {
        lines.push(`- ${item}`);
    }
}

function formatRefs(refs = []) {
    const list = (refs || [])
        .filter((ref) => ref?.path)
        .slice(0, 2)
        .map((ref) => ref.lineStart && ref.lineEnd ? `${ref.path}:${ref.lineStart}-${ref.lineEnd}` : ref.path);
    return list.length > 0 ? ` [source: ${list.join(', ')}]` : '';
}
