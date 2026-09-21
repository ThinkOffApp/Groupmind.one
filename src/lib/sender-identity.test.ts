// SPDX-License-Identifier: AGPL-3.0-only
// Regression tests for the room/DM sender-identity forgery (2026-09-19).
// Run: cd antfarm && npx tsx src/lib/sender-identity.test.ts

import { identityMetaIsTrusted, trustedUserMeta, projectRoomSender, dmParticipantIds, type UserProfile } from './sender-identity';
import * as idem from './message-idempotency';
const { stripReservedClientFields } = idem;
// Read defensively: on the PRE-FIX module this export does not exist, and the
// point of these tests is to FAIL there, not to crash before reaching the
// behavioural assertions below.
const SERVER_OWNED_IDENTITY_FIELDS: readonly string[] =
    (idem as any).SERVER_OWNED_IDENTITY_FIELDS ?? [];

const WEB = 'cdc11d66-8953-4daa-8d23-18583a54ddd1';
const AGENT = '9d5be6b1-8eb1-45ab-b117-1271be778e8f';
const PETRUS_USER = '00000000-1111-2222-3333-444444444444';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string) {
    if (cond) { console.log(`  ✅ ${name}`); passed++; }
    else { console.log(`  ❌ ${name}`); failed++; }
}

console.log('\nREAD GATE — the forgery that prompted this');
assert(
    trustedUserMeta(
        { from_agent_id: AGENT, metadata: { user: { id: PETRUS_USER, email: 'petrus@example.com' } } },
        WEB,
    ) === null,
    'an AGENT row claiming a human user id is NOT believed (the exploit)',
);
assert(
    trustedUserMeta(
        { from_agent_id: AGENT, metadata: { user: { email: 'petrus@example.com' } } },
        WEB,
    ) === null,
    'the email-only forgery is not believed either (it drove the handle fallback)',
);
assert(
    trustedUserMeta(
        { from_agent_id: WEB, metadata: { user: { id: PETRUS_USER, email: 'petrus@example.com' } } },
        WEB,
    )?.id === PETRUS_USER,
    'a genuine web-agent row IS believed (control: the gate is not just "always false")',
);

console.log('\nREAD GATE — the OLD logic, to prove these inputs are a real exploit');
{
    // Verbatim shape of the pre-fix reader (rooms/[room]/messages/route.ts:267-281):
    // metadata.user was believed on ANY row, with an email fallback for the handle.
    const oldReader = (row: any) => {
        const userId = row.metadata?.user?.id;
        const userEmail = row.metadata?.user?.email;
        let senderHandle = row.from_agent?.handle ?? 'unknown';
        let isHuman = false;
        if (userId) {
            isHuman = true;
            senderHandle = row.profileHandle || userEmail?.split('@')[0] || 'Human';
        }
        return { senderHandle, isHuman };
    };
    const forged = {
        from_agent_id: AGENT,
        from_agent: { handle: '@some-agent' },
        metadata: { user: { id: PETRUS_USER, email: 'petrus@example.com' } },
    };
    const before = oldReader(forged);
    assert(before.senderHandle === 'petrus' && before.isHuman === true,
        'OLD reader returns from:petrus isHuman:true for an agent row — the exploit is real');
    assert(trustedUserMeta(forged, WEB) === null,
        'NEW gate rejects the exact same row');
}

console.log('\nREAD GATE — fail-closed edges');
assert(trustedUserMeta(null, WEB) === null, 'null row -> null');
assert(trustedUserMeta({ metadata: { user: { id: PETRUS_USER } } }, WEB) === null, 'missing from_agent_id -> null');
assert(trustedUserMeta({ from_agent_id: null, metadata: { user: { id: PETRUS_USER } } }, WEB) === null, 'null from_agent_id -> null');
assert(
    identityMetaIsTrusted({ from_agent_id: null }, '') === false,
    'an EMPTY webUserAgentId trusts nothing (would otherwise match null rows)',
);
assert(trustedUserMeta({ from_agent_id: WEB, metadata: {} }, WEB) === null, 'web row with no user meta -> null');
assert(trustedUserMeta({ from_agent_id: WEB, metadata: { user: { id: PETRUS_USER } } }, WEB)?.email === null, 'absent email -> null, not undefined');

console.log('\nWRITE STRIP — identity keys are server-owned');
assert(SERVER_OWNED_IDENTITY_FIELDS.includes('user'), '`user` is declared server-owned');
assert(SERVER_OWNED_IDENTITY_FIELDS.includes('dm'), '`dm` is declared server-owned');
{
    const out = stripReservedClientFields({
        user: { id: PETRUS_USER, email: 'petrus@example.com' },
        dm: { to_user_id: PETRUS_USER },
        client_message_id: 'x',
        reply_to: 'keep-me',
    });
    assert(!('user' in out), 'caller-supplied `user` is stripped on write');
    assert(!('dm' in out), 'caller-supplied `dm` is stripped on write');
    assert(!('client_message_id' in out), 'reserved idempotency field still stripped (no regression)');
    assert(out.reply_to === 'keep-me', 'ordinary caller metadata still survives (control)');
}

console.log('\nWRITE STRIP — must stay NARROW (claudeMB review, pre-PR)');
{
    // On the GENERIC /api/v1/messages route, caller metadata is the ONLY
    // carrier for `actions` and `intent_id` — that route has no top-level
    // handling for either (0 occurrences, against 5 and 7 in the room route
    // as a control). The daemon posts confirmation and choice cards through
    // it. So broadening this strip to metadata wholesale would silently kill
    // every Approve/Deny card and every choice button in one commit, and it
    // would present as "the buttons stopped rendering", not as a server
    // change. These assertions exist to fail if anyone widens it.
    const card = stripReservedClientFields({
        actions: ['claude-opus-5', 'claude-sonnet-5'],
        intent_id: '4153315f',
        user: { id: 'forged' },
    });
    assert(Array.isArray(card.actions) && (card.actions as string[]).length === 2,
        '`actions` SURVIVES the strip — confirmation and choice buttons depend on it');
    assert(card.intent_id === '4153315f',
        '`intent_id` SURVIVES the strip — without it a card cannot be settled');
    assert(!('user' in card), 'and the forged identity is still removed from the same object');
}

console.log('\nPROJECTION — the reader\'s own output, on realistic STORED ROWS');
{
    // Rows shaped as the GET actually selects them, incl. the joined from_agent.
    const profiles = new Map<string, UserProfile>([
        [PETRUS_USER, { name: 'Petrus', avatar_url: 'https://x/p.png', handle: 'petrus' }],
    ]);
    const proj = (row: any) => projectRoomSender(row, profiles, WEB);

    // codexmb case 1: a genuine session post still resolves to the human.
    const genuine = proj({
        from_agent_id: WEB,
        from_agent: { handle: '@web_user', name: 'Web User' },
        metadata: { user: { id: PETRUS_USER, email: 'petrus@example.com' } },
    });
    assert(genuine.senderHandle === 'petrus' && genuine.isHuman === true && genuine.senderName === 'Petrus',
        'genuine session post still projects as the human, handle/name/isHuman intact');
    assert(genuine.avatarUrl === 'https://x/p.png', 'and still gets the profile avatar');

    // codexmb case 2: a metadata-only spoof keeps its AUTHENTICATED identity.
    const spoof = proj({
        from_agent_id: AGENT,
        from_agent: { handle: '@some-agent', name: 'Some Agent', metadata: { avatar_url: 'https://x/a.png' } },
        metadata: { user: { id: PETRUS_USER, email: 'petrus@example.com' } },
    });
    assert(spoof.senderHandle === '@some-agent', 'spoofing agent is still shown as ITSELF, not as petrus');
    assert(spoof.isHuman === false, 'and is still not human');
    assert(spoof.senderName === 'Some Agent' && spoof.avatarUrl === 'https://x/a.png',
        'name and avatar stay the agent\'s too, not the impersonated profile\'s');

    // codexmb case 3: a LEGACY forged row, already in the table before the strip.
    const legacy = proj({
        from_agent_id: AGENT,
        from_agent: { handle: '@hermes', name: 'Hermes' },
        metadata: { user: { id: PETRUS_USER, email: 'petrus@example.com' }, legacy: true },
    });
    assert(legacy.senderHandle === '@hermes' && legacy.isHuman === false,
        'a legacy forged row cannot move the reader either — the fix is not write-only');

    // The email fallback was the nastiest part: no profile lookup needed.
    const emailOnly = proj({
        from_agent_id: AGENT,
        from_agent: { handle: '@some-agent', name: 'Some Agent' },
        metadata: { user: { id: 'unknown-id', email: 'petrus@example.com' } },
    });
    assert(emailOnly.senderHandle === '@some-agent',
        'the email-local-part fallback cannot be reached from an agent row');

    // Control: an ordinary agent row with no identity metadata is unchanged.
    const plain = proj({ from_agent_id: AGENT, from_agent: { handle: '@claudemm', name: 'ClaudeMM' }, metadata: {} });
    assert(plain.senderHandle === '@claudemm' && plain.isHuman === false, 'ordinary agent row projects normally (control)');

    // Control: a genuine web row whose profile is missing still degrades as before.
    const noProfile = proj({
        from_agent_id: WEB, from_agent: { handle: '@web_user', name: 'Web User' },
        metadata: { user: { id: 'someone-else', email: 'ada@example.com' } },
    });
    assert(noProfile.senderHandle === 'ada' && noProfile.isHuman === true,
        'genuine web row with no profile still falls back to the email local part (behaviour preserved)');
}

console.log('\nDM ROUTING — sender and recipient are DIFFERENT claims (codexmb blocking review)');
{
    const OTHER_USER = '99999999-8888-7777-6666-555555555555';

    // The regression this block exists for: an agent->HUMAN DM. The server
    // writes dm.to_user_id from resolveRecipient for EVERY sender, so this row
    // has from_agent_id = a real agent and to_agent_id = null. Gating the
    // recipient on the sender discarded it and returned to:null.
    const agentToHuman = dmParticipantIds({
        from_agent_id: AGENT,
        metadata: { dm: { to_user_id: PETRUS_USER } },
    }, WEB);
    assert(agentToHuman.recipientUserId === PETRUS_USER,
        'agent->human DM KEEPS its recipient — the d424999 regression');
    assert(agentToHuman.senderUserId === null,
        'and still claims no human sender');

    // human->human: both ends survive.
    const humanToHuman = dmParticipantIds({
        from_agent_id: WEB,
        metadata: { user: { id: PETRUS_USER }, dm: { to_user_id: OTHER_USER } },
    }, WEB);
    assert(humanToHuman.senderUserId === PETRUS_USER && humanToHuman.recipientUserId === OTHER_USER,
        'human->human DM keeps both sender and recipient');

    // human->agent: sender survives, no human recipient.
    const humanToAgent = dmParticipantIds({
        from_agent_id: WEB, metadata: { user: { id: PETRUS_USER } },
    }, WEB);
    assert(humanToAgent.senderUserId === PETRUS_USER && humanToAgent.recipientUserId === null,
        'human->agent DM keeps the human sender, no recipient user');

    // The forgery still fails on the half that matters.
    const forged = dmParticipantIds({
        from_agent_id: AGENT,
        metadata: { user: { id: PETRUS_USER }, dm: { to_user_id: OTHER_USER } },
    }, WEB);
    assert(forged.senderUserId === null,
        'an agent row still cannot claim a human SENDER, even while its recipient is honoured');
    assert(forged.recipientUserId === OTHER_USER,
        'and honouring the recipient is deliberate, not an oversight — recorded so a future tightening has to argue with it');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
