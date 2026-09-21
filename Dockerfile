# GroupMind - Next.js app image.
#
# Used by docker-compose.yml for the self-host stack, and usable on its own
# for any container host.
#
# Fixes over the previous version of this file:
#   - node:18 -> node:22. Next 16 requires Node >= 20.9; the old base could
#     not have built this app.
#   - the old runtime stage copied `next.config.js`, which does not exist in
#     this repo (it is `next.config.ts`), so the build failed at that COPY.
#   - NEXT_PUBLIC_* are inlined into the client bundle at BUILD time, so they
#     have to arrive as build args, not only as runtime env.

# ---- Builder ---------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# Public vars are baked into the browser bundle here. They are not secrets:
# the anon key is designed to be shipped to the client.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_BASE_URL
ARG NEXT_PUBLIC_LLM_BASE_URL
ARG NEXT_PUBLIC_CONTACT_EMAIL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL \
    NEXT_PUBLIC_LLM_BASE_URL=$NEXT_PUBLIC_LLM_BASE_URL \
    NEXT_PUBLIC_CONTACT_EMAIL=$NEXT_PUBLIC_CONTACT_EMAIL \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---- Runtime ---------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3005

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/.next          ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public         ./public
COPY --from=builder --chown=nextjs:nodejs /app/node_modules   ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json   ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts

USER nextjs
EXPOSE 3005

CMD ["npm", "run", "start", "--", "--port", "3005", "--hostname", "0.0.0.0"]
