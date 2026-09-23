# =============================================================================
# PO-to-SO Automation Cockpit — single-container image
#
# One container runs the API, the in-process workers, the built SPA and
# (optionally) the SAP simulator. They are together on purpose: the simulator
# reads `integration/outbound` and writes `integration/inbound`, so it MUST
# share a filesystem with the API. Splitting them across two hosts breaks the
# folder handoff, which is the whole integration.
#
# Serving the SPA from the API process also means the UI and API share an
# origin, so CORS never applies to the authorised PDF fetch.
# =============================================================================

# ---------------------------------------------------------------- build ------
FROM node:22-slim AS build

WORKDIR /app

# Prisma's engine download needs these at install time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Manifests first so a dependency-free code change reuses the install layer.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY . .

# Generate the client against THIS image's platform, so the query engine binary
# matches the runtime stage (debian/openssl-3) rather than the build host.
RUN npx prisma generate --schema backend/prisma/schema.prisma

RUN npm -w backend run build
RUN npm -w frontend run build

# -------------------------------------------------------------- runtime ------
FROM node:22-slim AS runtime

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    STORAGE_ROOT=/app/data/storage \
    INTEGRATION_ROOT=/app/data/integration \
    WEB_ROOT=/app/frontend/dist

# node_modules is copied wholesale rather than reinstalled with --omit=dev:
# the generated Prisma client and its platform-matched engine live in there.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/prisma ./backend/prisma
COPY --from=build /app/frontend/dist ./frontend/dist
COPY docker/start.sh ./docker/start.sh

# Strip CRLF: the script is authored on Windows and bash would otherwise fail with
# "\r: command not found" on every line.
RUN sed -i 's/\r$//' ./docker/start.sh \
 && chmod +x ./docker/start.sh \
 && mkdir -p /app/data/storage /app/data/integration \
 && chown -R node:node /app/data

USER node

# Render/Railway inject PORT; 4010 is only the local default.
ENV PORT=4010
EXPOSE 4010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["./docker/start.sh"]
