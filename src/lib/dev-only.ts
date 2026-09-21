// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The gate on every dev-only surface in this app.
 *
 * One expression, one place. A dev fixture route serves unauthenticated data
 * shaped exactly like a real user's fleet, so the difference between shipping
 * it and not shipping it is this boolean - it must not be re-typed per file
 * where one of the copies can quietly say `!==`.
 *
 * `process.env.NODE_ENV` is inlined by the Next compiler at build time, so a
 * production build turns these guards into constants and the fixture code is
 * unreachable in the deployed bundle rather than merely unreached.
 */
export const IS_DEV_ONLY_ENABLED = process.env.NODE_ENV !== 'production';
