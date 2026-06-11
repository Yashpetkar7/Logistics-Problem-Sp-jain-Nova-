# Nova Shuttle — one tiny container, runs identically anywhere.
# Build:  docker build -t nova-shuttle .
# Run:    docker run -p 3000:3000 -e ADMIN_PASS=change-me nova-shuttle
FROM node:20-alpine

WORKDIR /app

# No dependencies to install — pure Node. Copy package metadata first for layer caching.
COPY package.json ./
COPY server.js ./
COPY public ./public

# Persist the demo database outside the image if a volume is mounted at /app/data
VOLUME /app/data

ENV PORT=3000
EXPOSE 3000

# Drop to a non-root user for safety
RUN addgroup -S nova && adduser -S nova -G nova && chown -R nova /app
USER nova

CMD ["node", "server.js"]
