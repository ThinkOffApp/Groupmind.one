// SPDX-License-Identifier: AGPL-3.0-only
// Unit test for the GitHub webhook -> room line formatter
// Run: cd antfarm && npx tsx src/lib/github-events.test.ts

import { formatGithubEvent, isInsider, parseInsiders, type GithubPayload } from './github-events';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name}`);
        failed++;
    }
}

const INSIDERS = ['ThinkOffApp'];
const repo = { name: 'antfarm', full_name: 'ThinkOffApp/antfarm', stargazers_count: 3 };
const outsider = { login: 'someone-else' };
const insider = { login: 'thinkoffapp' }; // lower case on purpose

function post(event: string, payload: GithubPayload) {
    const r = formatGithubEvent(event, payload, INSIDERS);
    return r.kind === 'post' ? r : null;
}
function ignored(event: string | null, payload: GithubPayload) {
    const r = formatGithubEvent(event, payload, INSIDERS);
    return r.kind === 'ignore' ? r.reason : null;
}

console.log('\nInsider filter');
assert(isInsider('ThinkOffApp', INSIDERS), 'exact login is insider');
assert(isInsider('thinkoffapp', INSIDERS), 'login match is case-insensitive');
assert(isInsider('dependabot[bot]', INSIDERS), 'GitHub app bots are insiders');
assert(isInsider(undefined, INSIDERS), 'missing sender is treated as insider (nothing to attribute)');
assert(!isInsider('someone-else', INSIDERS), 'unknown login is an outsider');
assert(parseInsiders(' petrus ,, Other ', ['ThinkOffApp']).join(',') === 'ThinkOffApp,petrus,Other',
    'env list is trimmed, de-duplicated and appended to defaults');
assert(parseInsiders(undefined, ['ThinkOffApp']).join(',') === 'ThinkOffApp', 'missing env keeps defaults');

console.log('\nMerged PR line is unchanged and posts for insiders too');
const mergedPr = {
    action: 'closed', sender: insider, repository: repo,
    pull_request: { number: 121, title: 'fix: sidebar', merged: true, html_url: 'https://x/pr/121', merged_by: { login: 'ThinkOffApp' } },
};
const merged = post('pull_request', mergedPr);
assert(merged?.body === 'Merged: antfarm#121 "fix: sidebar" by ThinkOffApp - https://x/pr/121', 'merged line byte-identical to the antfarm#87 format');
assert(JSON.stringify(merged?.metadata) === JSON.stringify({ source: 'github-webhook', repo: 'antfarm', pr: 121 }), 'merged metadata unchanged');
assert(ignored('pull_request', { ...mergedPr, pull_request: { ...mergedPr.pull_request, merged: false } }) === 'not a merge', 'closed without merge is ignored');
assert(post('pull_request', { ...mergedPr, pull_request: { ...mergedPr.pull_request, title: 'x'.repeat(200) } })?.body.includes('"' + 'x'.repeat(120) + '"') === true, 'merged title still clipped at 120');

console.log('\nOutsider activity posts, insider activity does not');
const openedPr = { action: 'opened', sender: outsider, repository: repo, pull_request: { number: 5, title: 'Add thing', html_url: 'https://x/pr/5' } };
assert(post('pull_request', openedPr)?.body === 'PR opened: antfarm#5 "Add thing" by someone-else - https://x/pr/5', 'outsider PR opened');
assert(ignored('pull_request', { ...openedPr, sender: insider }) === 'insider thinkoffapp', 'insider PR opened is ignored');
assert(ignored('pull_request', { ...openedPr, action: 'synchronize' }) === 'pull_request synchronize', 'PR synchronize is ignored');
assert(post('pull_request', { ...openedPr, action: 'reopened' })?.body.startsWith('PR reopened: antfarm#5') === true, 'PR reopened posts');

const review = { action: 'submitted', sender: outsider, repository: repo, pull_request: { number: 5 }, review: { state: 'changes_requested', body: 'Please  fix\nthis', html_url: 'https://x/r/1' } };
assert(post('pull_request_review', review)?.body === 'PR review (changes requested): antfarm#5 by someone-else "Please fix this" - https://x/r/1', 'review with body, whitespace collapsed');
assert(ignored('pull_request_review', { ...review, review: { state: 'commented', body: '', html_url: 'https://x/r/2' } }) === 'empty review wrapper', 'empty commented review is ignored');
assert(post('pull_request_review', { ...review, review: { state: 'approved', body: null, html_url: 'https://x/r/3' } })?.body === 'PR review (approved): antfarm#5 by someone-else - https://x/r/3', 'approval without body has no quote');

const reviewComment = { action: 'created', sender: outsider, repository: repo, pull_request: { number: 5 }, comment: { body: 'nit', html_url: 'https://x/c/1' } };
assert(post('pull_request_review_comment', reviewComment)?.body === 'PR comment: antfarm#5 by someone-else "nit" - https://x/c/1', 'inline PR comment');
assert(ignored('pull_request_review_comment', { ...reviewComment, action: 'edited' }) === 'review comment edited', 'edited inline comment ignored');

const issue = { action: 'opened', sender: outsider, repository: repo, issue: { number: 9, title: 'Crash on start', html_url: 'https://x/i/9' } };
assert(post('issues', issue)?.body === 'Issue opened: antfarm#9 "Crash on start" by someone-else - https://x/i/9', 'issue opened');
assert(post('issues', { ...issue, action: 'closed' })?.body.startsWith('Issue closed:') === true, 'issue closed posts');
assert(ignored('issues', { ...issue, action: 'labeled' }) === 'issues labeled', 'issue labeled ignored');
assert(post('issues', issue)?.metadata.issue === 9, 'issue metadata carries the number');

const longBody = 'word '.repeat(60);
const issueComment = { action: 'created', sender: outsider, repository: repo, issue: { number: 9 }, comment: { body: longBody, html_url: 'https://x/ic/1' } };
const ic = post('issue_comment', issueComment);
assert(ic?.body.startsWith('Issue comment: antfarm#9 by someone-else "word word') === true, 'issue comment posts');
assert((ic?.body.match(/"([^"]*)"/)?.[1].length ?? 0) === 140 && ic!.body.includes('…'), 'comment snippet clipped to 140 chars with ellipsis');
const prConvo = post('issue_comment', { ...issueComment, issue: { number: 5, pull_request: {} } });
assert(prConvo?.body.startsWith('PR comment: antfarm#5') === true, 'comment on a PR conversation is labelled PR');
assert(prConvo?.metadata.pr === 5 && !('issue' in prConvo.metadata), 'PR conversation comment metadata uses pr, not issue');
assert(ic?.metadata.issue === 9 && !('pr' in ic.metadata), 'issue comment metadata uses issue, not pr');

assert(post('star', { action: 'created', sender: outsider, repository: repo })?.body === 'Star: antfarm starred by someone-else (3 stars)', 'star created');
assert(post('star', { action: 'created', sender: outsider, repository: { ...repo, stargazers_count: 1 } })?.body === 'Star: antfarm starred by someone-else (1 star)', 'singular star');
assert(ignored('star', { action: 'deleted', sender: outsider, repository: repo }) === 'star deleted', 'unstar ignored');
assert(post('fork', { sender: outsider, repository: repo, forkee: { full_name: 'someone-else/antfarm', html_url: 'https://x/f' } })?.body === 'Fork: antfarm forked by someone-else - https://x/f', 'fork');

const discussion = { action: 'created', sender: outsider, repository: repo, discussion: { number: 2, title: 'Q?', html_url: 'https://x/d/2' } };
assert(post('discussion', discussion)?.body === 'Discussion: antfarm#2 "Q?" by someone-else - https://x/d/2', 'discussion created');
assert(post('discussion_comment', { ...discussion, comment: { body: 'A.', html_url: 'https://x/dc/1' } })?.body === 'Discussion comment: antfarm#2 by someone-else "A." - https://x/dc/1', 'discussion comment');
assert(ignored('discussion', { ...discussion, action: 'answered' }) === 'discussion answered', 'discussion answered ignored');

console.log('\nOutsider text cannot carry live Markdown');
const hostile = { ...issue, issue: { number: 10, title: '![x](https://attacker.example/pixel) <img src=x> *bold* `code` #1 | ~s~', html_url: 'https://x/i/10' } };
const hostileLine = post('issues', hostile)?.body ?? '';
assert(hostileLine.includes('\\!\\[x\\]\\(https://attacker.example/pixel\\)'), 'image syntax in a title is escaped');
assert(hostileLine.includes('\\<img src=x\\>'), 'inline HTML is escaped');
assert(hostileLine.includes('\\*bold\\* \\`code\\` \\#1 \\| \\~s\\~'), 'emphasis, code, heading, table and strikethrough markers are escaped');
assert(post('issue_comment', { ...issueComment, comment: { body: '[link](https://evil) and back\\slash', html_url: 'https://x/ic/2' } })?.body.includes('"\\[link\\]\\(https://evil\\) and back\\\\slash"') === true, 'comment bodies are escaped too, including backslashes');
assert(post('issues', issue)?.body === 'Issue opened: antfarm#9 "Crash on start" by someone-else - https://x/i/9', 'plain text is untouched');

console.log('\nUnknown / missing events');
assert(ignored('push', { sender: outsider, repository: repo }) === 'push', 'push is ignored with the event name');
assert(ignored(null, { sender: outsider }) === 'no event', 'missing event header');
assert(post('issues', { ...issue, repository: undefined })?.body.startsWith('Issue opened: unknown-repo#9') === true, 'missing repository falls back to unknown-repo');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
