FROM node:20-slim

WORKDIR /app

# Install dependencies first (layer cache).
# node:20-slim is Debian-based — better-sqlite3 uses its pre-built Linux binary,
# no C++ compilation needed.
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Create persistent dirs (data is mounted as a volume at runtime)
RUN mkdir -p logs data

EXPOSE 3500

CMD ["node", "server.js"]
