FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Install all dependencies (including dev)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

# Copy built files and migrations
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/src/db/migrations ./dist/db/migrations

# Set database path to mounted volume
ENV DATABASE_PATH=/app/data/nodestacker.db
ENV NODE_ENV=production

EXPOSE 3000

# Run migrations then start server
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
