// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Minimal Supabase stand-in for exercising a real route handler.
 *
 * Not a Supabase emulator: it records the table and the filters a query
 * applied, and returns whatever rows the fixture registered for that table.
 * That is enough to drive a GET end to end -- request in, JSON body out --
 * which is the thing a helper test cannot do (codexmb: "a route calling a
 * helper does not test the wiring").
 *
 * Every chainable method returns `this`; the terminal methods (`single`,
 * `in`, `limit`, `maybeSingle`) resolve. `limit` is also chainable in the
 * real client, so it resolves to a thenable that is ALSO a builder.
 */
export type Tables = Record<string, any[]>;

/** Resolve a PostgREST column reference against a row, including the JSON
 * arrow forms the DM query uses (`metadata->dm->>to_user_id`). */
export function resolveColumn(row: any, ref: string): any {
    if (!ref.includes('->')) return row[ref];
    // `a->b->>c` and `a->b->c` both walk the same path here; the ->> vs ->
    // distinction is text-vs-json in Postgres and irrelevant to an equality
    // test against a string.
    const parts = ref.split(/->>?/).filter(Boolean);
    let v = row;
    for (const part of parts) {
        if (v == null) return undefined;
        v = v[part];
    }
    return v;
}

/** Evaluate a PostgREST `.or()` string: comma-separated `col.op.value`,
 * true when ANY clause matches. Only `eq` and `is` are implemented -- enough
 * for the DM inbox query (`to_agent_id.eq.X,from_agent_id.eq.X,
 * metadata->dm->>to_user_id.eq.Y`), and an unknown operator THROWS rather
 * than silently matching nothing, so a query shape this cannot evaluate fails
 * loudly instead of quietly passing a test. */
export function matchesOr(row: any, spec: string): boolean {
    for (const clause of spec.split(',')) {
        const m = clause.match(/^(.+?)\.(eq|is)\.(.*)$/);
        if (!m) throw new Error(`route-fixture: cannot parse or() clause ${JSON.stringify(clause)}`);
        const [, col, op, raw] = m;
        const actual = resolveColumn(row, col);
        if (op === 'is') {
            if (raw === 'null' && (actual ?? null) === null) return true;
        } else if (String(actual) === raw) {
            return true;
        }
    }
    return false;
}

export function makeStubSupabase(
    tables: Tables,
    calls: { table: string; filters: any[] }[] = [],
    inserts: { table: string; row: any }[] = [],
) {
    const client: any = {
        _t: '', _f: [] as any[],
        from(table: string) {
            const q: any = Object.create(client);
            q._t = table; q._f = [];
            calls.push({ table, filters: q._f });
            return q;
        },
        select() { return this; },
        eq(k: string, v: any) { this._f.push(['eq', k, v]); return this; },
        or(s: string) { this._f.push(['or', s]); return this; },
        is(k: string, v: any) { this._f.push(['is', k, v]); return this; },
        gt(k: string, v: any) { this._f.push(['gt', k, v]); return this; },
        lt(k: string, v: any) { this._f.push(['lt', k, v]); return this; },
        order() { return this; },
        rows() { return tables[this._t] ?? []; },
        in(k: string, vals: any[]) {
            this._f.push(['in', k, vals]);
            const out = this.rows().filter((r: any) => vals.includes(r[k]));
            return Promise.resolve({ data: out, error: null });
        },
        single() {
            const rows = this.applyEq(this.rows());
            return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { code: 'PGRST116' } });
        },
        maybeSingle() { return this.single(); },
        applyEq(rows: any[]) {
            for (const f of this._f) {
                if (f[0] === 'eq') rows = rows.filter((r: any) => r[f[1]] === f[2]);
                else if (f[0] === 'is') rows = rows.filter((r: any) => (r[f[1]] ?? null) === f[2]);
                else if (f[0] === 'or') rows = rows.filter((r: any) => matchesOr(r, f[1]));
            }
            return rows;
        },
        /** Capture an insert so a POST test can assert on the STORED row.
         * Pushes into `tables[table]` and into `inserts`, then supports the
         * `.select(...).single()` the routes chain onto it. */
        insert(row: any) {
            const stored = { id: `stored-${(tables[this._t] ?? []).length + 1}`, ...row };
            (tables[this._t] ||= []).push(stored);
            inserts.push({ table: this._t, row: stored });
            const p: any = Promise.resolve({ data: stored, error: null });
            p.select = () => p;
            p.single = () => Promise.resolve({ data: stored, error: null });
            return p;
        },
        limit() {
            const p: any = Promise.resolve({ data: this.applyEq(this.rows()), error: null });
            // The real builder allows further chaining after .limit(); keep the
            // same shape so a route that calls .gt()/.lt() after it still works.
            p.gt = (k: string, v: any) => { this._f.push(['gt', k, v]); return p; };
            p.lt = (k: string, v: any) => { this._f.push(['lt', k, v]); return p; };
            return p;
        },
    };
    return client;
}
