# Contributing to GroupMind

Thanks for looking. This is a small project and a patch that explains itself is
worth more here than a large one that does not.

---

## Get it running first

```bash
git clone https://github.com/ThinkOffApp/groupmind.git && cd groupmind && ./selfhost/gen-env.sh && docker compose up
```

If **http://localhost:3005/spaces** lists four terrains, your environment is
sound and anything that breaks afterwards is your change. See the
[README](README.md) and [SELF-HOSTING.md](SELF-HOSTING.md).

For a faster edit loop, run the backing services in Docker and the app on the
host:

```bash
docker compose up db migrate auth rest kong
```

```bash
npm install && npm run dev
```

---

## Before you open a pull request

| | |
|---|---|
| Build | `npm run build` must exit 0 |
| Schema | `npm run schema:check` must be 11/11 if you touched `supabase/migrations/` |
| Boot | `docker compose down -v && docker compose up` must reach four terrains if you touched the stack |

`npm run schema:check` applies every migration to a throwaway in-process
Postgres. It needs no Docker and no Supabase account, and three of its eleven
cases are negative controls that must fail and do.

---

## House rules

**Migrations are append-only.** Add a new file; never edit one that has shipped.
Applied files are recorded in `schema_migrations_selfhost`, so an edit to an old
migration silently does nothing on every existing database and takes effect only
on fresh ones. That divergence is very hard to debug later.

**Never let an error render as an empty page.** This is the one thing we are
strict about. A swallowed query error that returns `[]` produces a calm,
successful-looking page with HTTP 200, and the operator has nothing to go on.
Several of the hardest bugs in this repo's history were exactly that. If you
cannot serve the data, say so.

**A check that cannot fail is not a check.** If you add a test or a guard, add
the case that proves it fires.

**Explain why in the code.** Comments here carry a lot of hard-won reasoning
about which apparently-arbitrary detail is load-bearing. Keep that habit: say
what breaks if the next person changes it back. Attribute generically ("a user
reported", "the owner asked for") rather than by name.

**Nothing personal in shipped code.** No personal email addresses, no home
directory paths, no real handles as defaults. Anything install-specific belongs
in configuration, with a safe default - see `selfhost/gen-env.sh`.

**Secrets never get committed.** `.env` is gitignored and `gen-env.sh` mints
per-install secrets precisely so no working credential is ever in the tree. If
you think you have committed one, say so immediately rather than quietly
force-pushing.

**No em dashes.** Use " - ". House style.

---

## Style

TypeScript, Next.js App Router, Tailwind. Match the file you are editing rather
than the wider ecosystem. `npm run lint` is advisory; `npm run build` is not.

---

## Commit messages

Say what changed and why it was wrong before. A commit that names the symptom a
user saw is worth several that name the function you edited.

---

## License

By contributing you agree your contribution is licensed under
[CC BY-NC 4.0](LICENSE), the same as the rest of the project. Note this is not
an OSI-approved open source license; commercial use is not permitted.
