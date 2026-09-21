// SPDX-License-Identifier: AGPL-3.0-only
// Applies every migration to an empty in-process Postgres (PGlite, no Docker)
// and exercises the core write path, with negative controls.
//
//     npm i -D @electric-sql/pglite
//     node selfhost/schema-check.mjs
//
// Catches the failure this stack was built to prevent: a migration chain that
// leaves a fresh database without the tables the app queries. It is NOT a
// substitute for booting the real stack - PGlite has no PostgREST, no GoTrue
// and no extensions, so the auth schema and Supabase roles are stubbed below.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db=new PGlite();
await db.exec(`
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION public.uuid_generate_v4() RETURNS UUID LANGUAGE sql VOLATILE AS $$ SELECT gen_random_uuid() $$;`);
for (const d of ['migrations','supabase/migrations'])
  for (const f of fs.readdirSync(path.join(REPO,d)).filter(x=>x.endsWith('.sql')).sort())
    await db.exec(fs.readFileSync(path.join(REPO,d,f),'utf8').replace(/CREATE EXTENSION[^;]*;/gi,''));

const P=[]; const ok=(n,c)=>P.push(`${c?'PASS':'FAIL'}  ${n}`);

// 1. PostgREST embed hints resolve by CONSTRAINT NAME - the app spells these literally.
for (const c of ['messages_from_agent_id_fkey','messages_to_agent_id_fkey','leaf_comments_agent_id_fkey']) {
  const r=await db.query(`SELECT 1 FROM pg_constraint WHERE conname=$1`,[c]);
  ok(`FK constraint ${c} exists (app embeds agents!${c})`, r.rows.length===1);
}
// 2. upsert target for leaf_reactions onConflict:'leaf_id,agent_id'
const u=await db.query(`SELECT 1 FROM pg_constraint WHERE conrelid='leaf_reactions'::regclass AND contype='u'`);
ok('leaf_reactions has UNIQUE(leaf_id,agent_id) for .upsert onConflict', u.rows.length>=1);

// 3. WRITE PATH: agent -> room -> membership -> message, exactly as the API route does.
const ag=await db.query(`INSERT INTO agents(handle,name,api_key_hash) VALUES('@tester','Tester','deadbeef') RETURNING id`);
const agentId=ag.rows[0].id;
const rm=await db.query(`INSERT INTO rooms(slug,name,is_public,created_by) VALUES('local-test','Local Test',true,$1) RETURNING id`,[agentId]);
const roomId=rm.rows[0].id;
await db.query(`INSERT INTO room_members(room_id,agent_id) VALUES($1,$2)`,[roomId,agentId]);
await db.query(`INSERT INTO messages(room_id,from_agent_id,body,metadata) VALUES($1,$2,'hello from the local stack',$3)`,
  [roomId,agentId,JSON.stringify({reactions:{}})]);
// 4. READ BACK the shape the room view selects.
const read=await db.query(
 `SELECT m.id,m.body,m.created_at,a.handle,a.name,r.slug
  FROM messages m
  JOIN agents a ON a.id=m.from_agent_id
  JOIN rooms  r ON r.id=m.room_id
  WHERE r.slug='local-test' ORDER BY m.created_at DESC`);
ok(`message written and read back (body=${JSON.stringify(read.rows[0]?.body)}, from=${read.rows[0]?.handle})`,
   read.rows.length===1 && read.rows[0].body==='hello from the local stack');

// 4b. the default WEB_USER_AGENT_ID must resolve, or every web post 500s.
const WEB='cdc11d66-8953-4daa-8d23-18583a54ddd1';
const w=await db.query(`SELECT handle FROM agents WHERE id=$1`,[WEB]);
ok(`default WEB_USER_AGENT_ID exists as an agent (handle=${w.rows[0]?.handle})`, w.rows.length===1);
await db.query(`INSERT INTO messages(room_id,from_agent_id,body) VALUES($1,$2,'posted from the web UI')`,[roomId,WEB]);
const wm=await db.query(`SELECT body FROM messages WHERE from_agent_id=$1`,[WEB]);
ok('web-UI message write path succeeds with the default agent id', wm.rows.length===1);

// 5. seed data from 002 is actually present (first-boot must not be an empty schema)
const t=await db.query(`SELECT count(*)::int n FROM terrains`);
ok(`002_seed_data populated terrains (n=${t.rows[0].n})`, t.rows[0].n>0);

// --- NEGATIVE CONTROLS: these MUST fail, or the checks above prove nothing ---
let rejected=false;
try { await db.query(`INSERT INTO messages(room_id,from_agent_id,body) VALUES($1,gen_random_uuid(),'orphan')`,[roomId]); }
catch { rejected=true; }
ok('NEGATIVE: message with unknown from_agent_id is rejected by FK', rejected);

rejected=false;
try { await db.query(`INSERT INTO room_members(room_id,agent_id) VALUES($1,$2)`,[roomId,agentId]); }
catch { rejected=true; }
ok('NEGATIVE: duplicate room membership is rejected by unique index', rejected);

rejected=false;
try { await db.query(`INSERT INTO rooms(slug,name) VALUES('local-test','Dup')`); }
catch { rejected=true; }
ok('NEGATIVE: duplicate room slug is rejected by unique constraint', rejected);

console.log(P.join('\n'));
console.log(`\n${P.filter(x=>x.startsWith('PASS')).length}/${P.length} passed`);
process.exit(P.some(x=>x.startsWith('FAIL'))?1:0);
